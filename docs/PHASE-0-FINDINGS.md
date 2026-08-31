# Phase 0 — Spike Findings

**Status: GATE PASSED ✅** · 2026-08-31 · commit `b9ea1d5`

> **Gate (from `ARCHITECTURE.md §12`):** *`update_cart` full-replace test passes on hostile fixtures.*
> **Result:** 42/42 tests green, 0 type errors, 0 production vulnerabilities, all latency budgets met.

---

## 1. What was built

| Module | Purpose |
|---|---|
| `src/types.ts` | UCP catalog + cart types, spec `2026-04-08`. Minor-unit money normalized at the boundary. |
| `src/transport.ts` | JSON-RPC 2.0 over `POST /api/ucp/mcp`. Deadlines, jittered retry, per-attempt timing hooks. |
| `src/client.ts` | Faithful 1:1 binding to all seven UCP tools. No hidden convenience. |
| **`src/cart.ts`** | **`SafeCart` — the gate.** Read-modify-write with field-loss guard and per-cart serialization. |
| `src/errors.ts` | Typed errors + retryability classification. |
| `test/mock-server.ts` | Deliberately hostile UCP mock with true PUT semantics. |
| `bench/latency.ts` | Per-tool latency harness with pass/fail budgets. |

```
npm test       → 42 passed (3 files)
npm run typecheck → clean
npm run bench  → ALL BUDGETS MET
npm audit --omit=dev → found 0 vulnerabilities
```

---

## 2. The gate: proving PUT semantics are survivable

### First, we armed the trap

`test/mock-fidelity.test.ts` exists to test **the mock, not our code**. Every safety test is vacuous if the mock is forgiving — `SafeCart` could be a no-op and the suite would still be green. So we prove the trap bites first:

> `update_cart DESTROYS every field omitted from the payload` — the naive
> `updateCart(id, { line_items: [...] })` that most implementations write
> wipes `attribution`, `buyer`, `note`, `discount_codes`, `attributes`,
> `context`, `signals`, **and two of the shopper's three items.**

### Then we proved we survive it

The `HOSTILE_CART` fixture carries every category of writable state a real shopper accumulates. Each loss is a distinct revenue bug:

| Lost field | Business consequence |
|---|---|
| `attribution` | We can no longer prove the agent earned the sale — kills the ROI story |
| `discount_codes` | Shopper is silently overcharged → chargeback |
| `buyer` | Abandoned-cart recovery breaks |
| a line item | Cart emptied mid-conversation |

22 tests in `cart-safety.test.ts` cover: full-field preservation across add/remove/setQuantity, quantity merging vs. duplication, same-variant-different-attributes as distinct lines, computed-field stripping, discount idempotency, buyer merging, authoritative message surfacing, and the guard-of-last-resort.

### Three design decisions that fell out of the spike

**1. Denylist computed fields, don't whitelist writable ones.**
Because `update_cart` is a full replacement, a whitelist would silently start *deleting* any writable field UCP adds in future. A denylist degrades safely — unknown fields pass through. There's a regression test asserting an unknown `loyalty_tier` field survives a round trip.

**2. Serialize mutations per cart.**
Two agent turns (or two browser tabs) racing a read-modify-write is a classic lost update: both read the same state, both PUT, the second silently discards the first. `SafeCart` chains mutations per cart id. Tested with 12 concurrent increments — all 12 land.

**3. Guard of last resort.**
`assertNoFieldLoss` throws `UnsafeCartWriteError` before any destructive PUT reaches the wire, naming the fields that would have been dropped. This should never fire in production; if it does, someone bypassed `SafeCart`.

---

## 3. Latency finding — a Phase 1 requirement

Client overhead is negligible (p50 **0.06 ms**), so real-world latency is pure network. Re-running with a simulated 120 ms RTT isolates the structural cost:

| Operation | p50 | RTTs |
|---|---:|---:|
| `search_catalog` / `get_product` / `get_cart` | 125 ms | 1 |
| naive `update_cart` (write only) | 126 ms | 1 |
| **`SafeCart.addLine` (read + write)** | **249 ms** | **2** |

**Safety costs exactly one extra round trip — ~125 ms on a realistic connection.**

That is affordable but not free, and it lands directly in the add-to-cart path the `EXPERIENCE-CONTRACT` says must feel instant.

> **➜ Phase 1 requirement:** cache the cart's writable projection in the Redis session on every read and write. The orchestrator then already holds current state, making the mutation path **1 RTT**, with a `get_cart` re-read only on cache miss or version conflict. Optimistic UI covers the remaining hop, so perceived latency stays at 0 ms.

---

## 4. Bugs found and fixed during the spike

**Unhandled promise rejection in the mutex (real, would crash production).**
The first `CartMutex` implementation chained `void next.finally(...)`, producing a derived promise that rejects with nobody handling it. Under Node's default `--unhandled-rejections=throw` that terminates the process. Fixed by making the sequencing tail *never* reject — it swallows outcomes purely for ordering, while the caller owns the real promise. A rejected tail would also have poisoned every subsequent mutation on that cart.

**Mock ignored `AbortSignal` (test-infrastructure defect).**
Two transport tests failed because the mock resolved normally after its simulated delay regardless of abort. That made timeouts and cancellation untestable — the deadline logic could have been silently broken and the suite would still have been green. The mock now honours `AbortSignal` exactly as real `fetch` does.

**`UcpTimeoutError` couldn't extend `UcpTransportError`.**
Literal-typed `override readonly name = '...'` on the base class prevented subclass narrowing. Widened to `: string`.

---

## 5. Open questions carried into Phase 1

### SPIKE-OPEN-QUESTION #1 — `meta` key encoding ⚠️

The docs render the agent profile as `meta.ucp-agent.profile`, which is ambiguous between a **literal dotted key** and a **nested object**:

```jsonc
{ "meta": { "ucp-agent.profile": "..." } }        // (A) — what we implemented
{ "meta": { "ucp-agent": { "profile": "..." } } } // (B) — the alternative
```

We chose (A) as the more common convention in this spec family, and isolated the decision in `UcpTransport.buildMeta()` so switching is a **one-function change**. The mock validates form (A), so our tests would not catch a mismatch.

**Action:** verify against a live development store before Phase 1 ships. This is the single highest-risk unknown — every request carries this field, so getting it wrong means nothing works. It is also the cheapest thing to verify (one curl against a dev store).

### SPIKE-OPEN-QUESTION #2 — distributed cart lock

`CartMutex` is **in-process only**. Production runs multiple orchestrator nodes behind a load balancer, so two nodes handling the same cart can still lose an update.

**Action:** back it with a Redis lock keyed on cart id (short TTL, fencing token) in Phase 1. The in-process mutex stays as the fast path for the common case where both turns land on the same node.

### SPIKE-OPEN-QUESTION #3 — rate limits

Shopify's UCP docs specify no explicit rate limits for catalog or cart tools. At 1M MAU we will find them empirically.

**Action:** instrument `onTiming` in staging, watch for 429s, and size the edge cache (`ARCHITECTURE.md §3.2`) accordingly. The 60 s catalog cache and the session-cached cart state from §3 above both reduce exposure.

---

## 6. Confirmations

- **No auth needed for catalog or cart tools.** Both accept unauthenticated requests; only `meta.ucp-agent.profile` is mandatory. Simplifies the anonymous shopper path considerably.
- **`cancel_cart` requires `meta.idempotency-key`.** Enforced in the client (`TypeError` if absent) and by the mock.
- **Constraints hold:** `lookup_catalog` max 10 ids (with `lookupCatalogChunked` for larger sets), `search_catalog` max 250 results.
- **Prices are minor units.** Normalized once at the boundary; never reaches a prompt or UI string.
- **Zero legacy surface.** `FORBIDDEN_LEGACY_TOOLS` is exported so CI can fail the build if a deprecated tool name ever appears. Legacy support ended **today**.

---

## 7. Verdict

**Gate passed. Phase 1 is cleared to start** — with one blocking prerequisite: **resolve OPEN-QUESTION #1 against a live development store before writing orchestrator code.** Everything else is additive.

Phase 1 inherits three concrete requirements from this spike:

1. Session-cache the cart writable projection → mutation path becomes 1 RTT
2. Redis-backed distributed cart lock
3. `SafeCart` is the only sanctioned mutation path — add a lint rule banning direct `client.updateCart` calls outside `cart.ts`
