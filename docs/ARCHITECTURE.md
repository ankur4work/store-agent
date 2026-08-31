# StoreAgent — System Architecture

**Version:** 1.0 · **Date:** 2026-08-31
**Design target:** 1M monthly active shoppers across ~5,000 merchants, p50 first-token < 350 ms, p50 voice mouth-to-ear < 500 ms, 99.95% availability.

---

## 1. Design principles

1. **Don't own what Shopify owns.** The catalog, cart, and order state live in Shopify. We query them live. We own conversation, grounding, memory, and attribution.
2. **Grounding is a code path, not a prompt.** Prompts are advisory; validators are enforcing.
3. **Latency is a budget, not an aspiration.** Every hop has an assigned millisecond allowance and a CI-enforced regression test.
4. **The widget is a guest on someone else's revenue.** It gets a hard byte budget and may never regress the merchant's Core Web Vitals.
5. **Degrade, never error.** There is always a next-best response, down to "leave your email."
6. **Prove value or lose the renewal.** Incrementality measurement is a first-class subsystem, not a reporting afterthought.

---

## 2. System topology

```
                        ┌────────────────────────────────┐
   Shopper browser      │  Cloudflare Edge (Workers/KV)  │
   ┌──────────────┐     │  · loader.js  (< 15 KB)        │
   │ Theme App    │◄───►│  · session token mint          │
   │ Extension    │ WSS │  · rate limit / bot filter     │
   │ (Shadow DOM) │     │  · catalog response cache 60s  │
   └──────┬───────┘     │  · geo route → nearest region  │
          │ WebRTC      └───────────────┬────────────────┘
          │                             │
          │              ┌──────────────▼──────────────────────────────┐
          │              │  Gateway  (Go, stateless, 100k conns/node)  │
          │              │  WS terminate · backpressure · fan-out      │
          │              └──────────────┬──────────────────────────────┘
          │                             │
          │              ┌──────────────▼──────────────────────────────┐
          │              │  Orchestrator (TypeScript)                  │
          │              │  agent loop · tool exec · speculation       │
          │              │  model routing · grounding validator        │
          │              └───┬───────────┬───────────┬─────────────────┘
          │                  │           │           │
          │        ┌─────────▼──┐  ┌─────▼──────┐  ┌─▼─────────────────┐
          │        │ Anthropic  │  │ Shopify    │  │ Policy Corpus     │
          │        │ Claude API │  │ UCP MCP    │  │ (pgvector)        │
          │        └────────────┘  │ /api/ucp/  │  └───────────────────┘
          │                        │    mcp     │
   ┌──────▼────────────────┐       └────────────┘
   │ Voice Lane            │
   │ LiveKit SFU           │       ┌───────────────────────────────────┐
   │ Deepgram Nova-3 (STT) │       │ Redis Cluster · Postgres ·        │
   │ Cartesia Sonic (TTS)  │       │ ClickHouse · S3                   │
   └───────────────────────┘       └───────────────────────────────────┘
```

Regions: `us-east`, `us-west`, `eu-central`, `ap-southeast`. Voice sessions are **region-pinned** — STT, LLM, and TTS must share a region or cross-region hops eat the entire latency budget.

---

## 3. Components

### 3.1 Widget — Theme App Extension (App Embed block)

| Decision | Choice | Why |
|---|---|---|
| Framework | **Preact + signals** | 4 KB runtime vs React's 45 KB; signals avoid re-render cascades that spike INP |
| Isolation | **Shadow DOM** | Merchant themes will otherwise fight our CSS; also protects them from ours |
| Bundle | Loader ≤ 15 KB gz, full panel ≤ 25 KB gz | Enforced in CI; build fails on regression |
| Load strategy | Loader only until intent | Nothing but the launcher exists before first interaction |
| Transport | WebSocket (text), WebRTC (voice), SSE fallback | |

**Load sequence:**
1. `loader.js` deferred, `type="module"`, ~8 KB — renders launcher only. No network calls, no fonts, no images.
2. On `pointerenter` / `focus` on the launcher → prefetch the panel chunk (user hasn't clicked yet; we've already paid the cost).
3. On open → panel mounts in < 100 ms from prefetched chunk.
4. Voice chunk (WebRTC + audio worklet, ~40 KB) loads **only** when the mic toggle is first pressed.

**Never:** auto-open on load, inject above-the-fold layout, load webfonts, or write to `document.body` before interaction.

### 3.2 Edge (Cloudflare Workers + KV)

- Mints short-lived session JWTs (shop domain, session id, 30 min TTL) so the origin never handles anonymous connection setup.
- Rate limits per IP and per shop before traffic reaches the gateway.
- **Caches catalog search responses** keyed on `(shop, normalized_query, locale)` with 60 s TTL. On a PDP for a popular product, this converts a 150 ms Shopify round trip into a 5 ms KV read. Hit rate in practice runs 55–70%.
- Serves the widget bundle from ~300 PoPs.

### 3.3 Gateway (Go)

Stateless WebSocket terminator. Go rather than Node specifically for connection density: goroutine-per-connection holds 100k+ sockets per node at modest memory, where Node's event loop degrades around ~30k with this message shape.

Responsibilities: connection lifecycle, heartbeat, backpressure (drop-oldest on slow consumers), session hydration from Redis, and routing to an orchestrator worker. Holds no state itself — any node can serve any reconnect.

### 3.4 Orchestrator (TypeScript)

Owns the agent loop. TypeScript here (not Go) because this is the fastest-changing surface in the system and the Anthropic SDK ergonomics matter more than raw throughput — the orchestrator is I/O-bound on the model anyway.

We hand-roll the loop rather than using the SDK tool runner, because we need two things it doesn't expose: **speculative tool execution before the model asks** (§6.2) and **stream abortion mid-generation** when the grounding validator fails.

### 3.5 Data plane

| Store | Use | Notes |
|---|---|---|
| **Redis Cluster** | Session state, rate limits, idempotency keys, hot cache | 30 min TTL on sessions |
| **Postgres** | Conversations, messages, merchants, attribution, holdout assignment | Partitioned by `merchant_id`; RLS for tenant isolation |
| **ClickHouse** | Event analytics, funnels, merchant dashboards | Postgres will not serve funnel queries at this event volume |
| **S3** | Voice recordings (opt-in only), transcript exports | Lifecycle policy: 30 day default, configurable, PII-tagged |

---

## 4. Shopify integration — UCP native

**All catalog and cart traffic goes to `POST https://{shop-domain}/api/ucp/mcp` (JSON-RPC 2.0).**

Every request carries `meta.ucp-agent.profile` — our published UCP agent profile URI.

### Catalog tools (no auth required)

| Tool | Use | Constraints |
|---|---|---|
| `search_catalog` | Natural-language product discovery | `query`, `context` (buyer signals), cursor pagination; max 250 results |
| `lookup_catalog` | Batch fetch by ID | Up to 10 IDs per call; accepts `gid://shopify/Product/123` |
| `get_product` | Full detail + variant selection | `id`, `selected` options; returns per-variant availability signals |

Prices come back in **minor currency units** — normalize once at the boundary, never in the prompt.

### Cart tools (no auth required)

| Tool | Semantics |
|---|---|
| `create_cart` | New cart with `line_items`, plus `context`, `attribution`, `buyer`, `signals` |
| `get_cart` | Read current state |
| `update_cart` | **PUT semantics — full replacement.** Omit a field and it is *removed*. |
| `cancel_cart` | Requires `meta.idempotency-key` (UUID) |

> ⚠️ **`update_cart` is the sharpest edge in this integration.** It replaces the entire cart. The orchestrator must always `get_cart` → merge → `update_cart` with the complete state. A partial payload silently empties the shopper's cart. This gets a dedicated integration test with a deliberately hostile fixture.

Responses arrive at `result.structuredContent.cart`, with a `messages` array carrying business outcomes (out-of-stock, quantity adjusted, etc.). **Surface those messages to the shopper verbatim** rather than letting the model paraphrase them — they are authoritative and paraphrasing is where hallucination enters.

### Migration status (why this matters today)

- 2026-04-22 — catalog moved to UCP; legacy tools deprecated
- 2026-06-24 — legacy `get_cart`/`update_cart` deprecated
- **2026-08-31 — legacy support ends (today)**

We never had legacy code. Competitors built on `/api/mcp` are breaking as of this date.

### Other Shopify surfaces

- **Admin GraphQL API** — merchant onboarding, plan/billing (Shopify Billing API), theme settings for brand tokens
- **Web Pixel Extension** — subscribes to `product_viewed`, `cart_updated`, `checkout_completed` for attribution
- **Webhooks** — `orders/create`, `app/uninstalled`, `shop/redact`, `customers/redact` (GDPR mandatory)
- **Customer Account API** — order status / returns, behind Level 2 protected customer data approval. Gated behind explicit shopper login; **not** on the anonymous path.

---

## 5. The grounding layer (anti-hallucination)

This is the core differentiator. Three independent mechanisms, defense in depth.

### 5.1 Source separation

| Data class | Source | Never |
|---|---|---|
| Price, stock, variants, images | **Live UCP catalog** | Cached beyond 60 s; embedded; summarized into the prompt |
| Shipping, returns, warranty, FAQ | **Owned corpus** (pgvector, per-merchant) | Answered from model prior knowledge |
| Order status | **Customer Account API**, authenticated | Guessed from conversation context |
| Brand voice, tone | System prompt | Used to justify a factual claim |

The corpus is small (typically 20–200 chunks per merchant: policy pages, FAQ, merchant-authored answers) and changes rarely — which is exactly why owning it is cheap and owning the catalog is not.

### 5.2 Citation enforcement

Every factual assertion the model makes about price, availability, shipping time, or policy must be traceable to a tool result **from the current turn**. We implement this with structured output on a side channel:

```ts
// The model returns prose for the shopper AND a machine-checkable claim set.
output_config: {
  format: {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        reply: { type: "string" },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              assertion: { type: "string" },
              kind: { type: "string", enum: ["price","stock","shipping","policy","other"] },
              source_tool_call_id: { type: "string" }
            },
            required: ["assertion","kind","source_tool_call_id"],
            additionalProperties: false
          }
        }
      },
      required: ["reply","claims"],
      additionalProperties: false
    }
  }
}
```

A deterministic validator then checks that each `source_tool_call_id` exists in this turn's tool results and that numeric claims match the tool payload. Mismatch → one regeneration with the failure fed back → on second failure, fall through to the escalation ladder. **No model in the loop for the check itself** where a string/number comparison suffices.

### 5.3 Refusal is a success state

The agent is explicitly rewarded for "I don't have that — let me get you someone who does." Escalation paths: email capture, ticket creation, live handoff. A refusal that captures an email is worth more than a confident wrong answer that produces a return.

---

## 6. Latency engineering

### 6.1 Text turn budget — target p50 350 ms to first token

| Stage | Budget | Technique |
|---|---:|---|
| Edge accept + JWT verify | 15 ms | Verify at edge, not origin |
| Session hydrate | 5 ms | Redis pipeline, single round trip |
| Speculative catalog search | *parallel* | Fired at submit, not after the model asks (§6.2) |
| Claude TTFT (warm cache) | 200–300 ms | Prompt caching; `effort: low`; region-local |
| First paint | 30 ms | rAF-batched render |
| **Total** | **~350 ms** | |

**Guardrails run in parallel with generation, not before it.** A pre-flight safety classifier serialized ahead of the model adds its full latency to every single turn. Instead we start generating immediately, run a Haiku 4.5 classifier concurrently on the input, and abort the stream if it trips. Users see a cancelled partial roughly never; everyone else saves 150 ms per turn.

### 6.2 Speculative tool execution

The dominant text-turn latency risk is a tool round trip: the model reads the message, decides to search, we call Shopify (80–250 ms), we send results back, the model starts over. That doubles TTFT.

So we **don't wait to be asked**:

1. On message submit, a cheap keyword/entity extraction runs locally (< 2 ms).
2. If it looks like product intent, `search_catalog` fires **immediately, in parallel** with the Claude request.
3. By the time the model emits a `tool_use` block, the result is usually already in hand — the round trip collapses to a memory read.
4. If the model asks for something different, we discard the speculation and pay the normal cost. Miss rate ~25%, and a miss costs only a wasted (edge-cached) Shopify call.
5. **The UI wins too:** skeleton product cards render from the speculative result while the model's prose is still streaming, so perceived latency is near zero.

Add the 60 s edge cache on `(shop, normalized_query)` and the common case — several shoppers asking about the same trending product — becomes a 5 ms KV hit.

### 6.3 Voice turn budget — target p50 500 ms mouth-to-ear

| Stage | Budget | Technique |
|---|---:|---|
| Semantic endpointing | 90 ms | **Not** silence-timeout — that alone costs 500–800 ms of dead air |
| Streaming STT (Deepgram Nova-3) | 60–100 ms | Interim results streamed continuously |
| LLM first token | 150–250 ms | Speculative start on interim transcript |
| TTS first chunk (Cartesia Sonic) | 40–90 ms | Sentence-level chunking |
| WebRTC transport | 20–40 ms | Region-pinned SFU |
| **Total** | **~400–500 ms** | |

Four techniques carry this:

- **Speculative generation on interim transcripts.** Start the model on the in-progress transcript; if the finalized text differs materially, cancel and restart. Most of the time it doesn't, and we've bought 150 ms.
- **Sentence-level TTS chunking.** Pipe the first complete sentence to TTS while the rest of the response is still generating. Audio starts before text finishes.
- **Barge-in under 50 ms.** Detected shopper speech cancels the TTS stream *and* aborts the in-flight Claude request. A voice agent that talks over you is unusable regardless of its latency numbers.
- **Region pinning.** STT, LLM, and TTS in one region. A single cross-region hop can consume the entire budget.

### 6.4 Rendering

- Stream tokens into a buffer; flush to DOM on `requestAnimationFrame`. **Per-token DOM writes are the classic INP killer** in chat UIs.
- `contain: layout paint` on the message list; virtualize past 50 messages.
- Animate `transform` and `opacity` only. No `height`, no `top`, no layout thrash.
- Product card images preloaded via `<link rel="preload">` from the speculative search result.

---

## 7. Model strategy & cost

### 7.1 Routing

| Tier | Model | Price /MTok | Use |
|---|---|---|---|
| Classify | `claude-haiku-4-5` | $1 / $5 | Intent, safety, language detect, claim validation assist |
| Workhorse | `claude-sonnet-5` | $3 / $15 | ~92% of conversational turns |
| Escalation | `claude-opus-5` | $5 / $25 | Multi-constraint product fit, policy edge cases, complex returns |

Escalation is triggered by the classifier, by tool-loop depth > 3, or by an explicit shopper frustration signal — never by default.

### 7.2 Thinking and effort — the non-obvious call

Claude Sonnet 5 runs **adaptive thinking by default** and defaults to `effort: "high"`. Both are wrong for a latency-sensitive retail turn.

The tempting fix is `thinking: {type: "disabled"}`. **Don't.** With thinking disabled, Sonnet 5 is measurably *less* likely to reach for tools — and this entire product is tool-driven. Disabling thinking would quietly degrade grounding, which is the thing we're selling.

Correct configuration for a routine turn:

```ts
{
  model: "claude-sonnet-5",
  thinking: { type: "adaptive" },        // keep it — preserves tool-calling behavior
  output_config: { effort: "low" },      // this is the latency/cost lever
  max_tokens: 2048,
}
```

Escalated turns move to `effort: "medium"` or Opus 5 at `"high"`. Sweep effort per route against a real eval set rather than picking one global value.

### 7.3 Prompt caching — the single biggest lever

Cache render order is `tools → system → messages`. One breakpoint on the last system block caches tools + system together.

**The cached prefix (per merchant):**
1. Tool definitions — serialized deterministically, sorted by name
2. Frozen system prompt — behavior, refusal policy, output contract
3. Merchant brand pack — voice, tone, policy summary, category taxonomy

Typically 10–14k tokens. Cache reads cost ~0.1×, so this drops per-turn input cost by roughly 90%.

**Silent invalidators to ban in code review** — any one of these silently disables caching with no error:

- ❌ `new Date()` or a session ID interpolated into the system prompt
- ❌ Cart state or current page in the system prompt (put it in the **last user turn**)
- ❌ `JSON.stringify` on an unsorted object or a `Set` for tool schemas
- ❌ Per-shopper personalization in the prefix (per-*merchant* is fine, per-*shopper* is not)
- ❌ Conditionally appending system sections behind feature flags

**Monitoring:** alert if `usage.cache_read_input_tokens` is 0 across repeated same-merchant turns. That metric is the canary for the entire cost model.

TTL: `1h` for merchants above ~50 sessions/hour (write cost 2× but amortizes); `5m` default for the long tail. Minimum cacheable prefix on Sonnet 5 is 1024 tokens — our prefix clears it comfortably.

### 7.4 Unit economics

Per turn, Sonnet 5, warm cache:

```
cached read   12,000 tok × $0.30/M  = $0.0036
uncached in      400 tok × $3.00/M  = $0.0012
output           300 tok × $15.00/M = $0.0045
                                      ─────────
                                      $0.0093 / turn
```

At 1M MAU × 1.5 sessions × 6 turns ≈ **9M turns/month ≈ $84k/month** in model spend, plus ~$25k infrastructure. Against ~5,000 merchants at a $99 blended ARPU (~$495k MRR), that's **~78% gross margin**.

Compare: SiteAgent charges $0.059/turn — a 6.3× markup on the same underlying cost. We can undercut them 4× and still run healthier margins, because we also deleted their vector-index cost center (§W1).

Without prompt caching the same volume costs ~$310k/month and the business doesn't work. **Caching is not an optimization here; it is the business model.**

### 7.5 Refusal handling

Claude Opus 5 and Fable-tier models can decline via safety classifiers — HTTP 200 with `stop_reason: "refusal"`. Code that reads `response.content[0]` unconditionally crashes on this.

```ts
if (response.stop_reason === "refusal") { return escalationLadder(ctx); }
```

On Opus 5 escalation paths, opt into server-side fallbacks rather than pinning a model:

```ts
betas: ["server-side-fallback-2026-07-01"],
fallbacks: "default",
```

Retail conversation rarely trips these classifiers, but a returns conversation mentioning a damaged battery or a chemical product occasionally will.

---

## 8. Multi-tenancy at scale

**Noisy-neighbour isolation.** One merchant's Black Friday must not starve the other 4,999.

- Per-merchant token bucket on requests *and* on monthly token budget
- Separate queue lanes; a merchant exceeding its share degrades to Haiku before it degrades anyone else
- Circuit breaker per merchant on repeated Shopify tool failures — a merchant with a broken storefront shouldn't consume orchestrator threads
- Per-merchant prompt-cache namespace (falls out of the prefix design naturally)
- Postgres row-level security keyed on `merchant_id`; no cross-tenant query is expressible

**Budget ladder:** at 80% of monthly allowance → soft-degrade to Haiku + notify merchant; at 100% → agent stays up in FAQ-only mode with an in-admin upsell. Never a hard cut-off mid-conversation with a shopper.

---

## 9. Reliability & degradation

Never show an error. Walk down the ladder:

```
Opus 5  →  Sonnet 5  →  Haiku 4.5  →  cached FAQ answer
        →  "Let me get a human on this" + email capture
        →  static contact form
```

- **Anthropic 429/529** — exponential backoff with jitter; shed to the next tier down; per-merchant queue drains at a controlled rate
- **Shopify UCP unavailable** — serve from the 60 s edge cache with an explicit "prices as of a moment ago" hedge; disable cart actions rather than guessing
- **Region failure** — sessions are in Redis, gateways are stateless: DNS failover reconnects mid-conversation with full history intact
- **Widget failure** — loader is wrapped so any exception removes the launcher entirely. A broken agent must never break the merchant's checkout.

SLOs: 99.95% availability, p95 first token < 700 ms, p95 voice < 800 ms, grounding-validator failure rate < 0.5%.

---

## 10. Attribution & incrementality

The retention subsystem.

**Deterministic chain:**
1. Agent sets `attribution` on `create_cart` with our session ID
2. Web Pixel Extension emits `checkout_completed` carrying the cart token
3. `orders/create` webhook provides server-side truth
4. Nightly reconciliation job joins all three in ClickHouse

**The holdout — the part nobody else does.** 5% of eligible sessions are deterministically assigned (hash of session ID) to *never see the agent*. The launcher simply doesn't render. This yields a genuine incrementality figure:

> "Agent-exposed sessions convert at 4.1% vs 3.2% holdout — **+28% lift, $47,200 incremental revenue this month.**"

That number survives merchant scrutiny in a way "influenced revenue" never does. It is our single strongest renewal and sales asset, and it costs 5% of exposure to produce.

---

## 11. Tech stack

| Layer | Choice |
|---|---|
| Widget | Preact + signals, Vite, Shadow DOM, ≤ 25 KB gz |
| Merchant admin | Remix + Polaris + App Bridge (Shopify's required embedded stack) |
| Edge | Cloudflare Workers + KV |
| Gateway | Go |
| Orchestrator | TypeScript / Node 22, `@anthropic-ai/sdk` |
| LLM | Claude Opus 5 / Sonnet 5 / Haiku 4.5 |
| Voice | LiveKit (WebRTC) · Deepgram Nova-3 (STT) · Cartesia Sonic (TTS) |
| Commerce | Shopify UCP MCP · Admin GraphQL · Web Pixels · Webhooks |
| Data | Postgres 17 · Redis Cluster · ClickHouse · S3 |
| Vectors | pgvector (policy corpus only — small, cheap, no separate service) |
| Infra | AWS multi-region + Cloudflare; Terraform; Kubernetes or Fly Machines |
| Observability | OpenTelemetry → Grafana; per-turn trace with token + cache + latency attribution |

---

## 12. Build sequence

| Phase | Duration | Deliverable | Gate |
|---|---|---|---|
| **0 — Spike** | 2 wks | UCP MCP client, cart merge semantics proven, latency harness | `update_cart` full-replace test passes on hostile fixtures |
| **1 — Text MVP** | 6 wks | Widget + gateway + orchestrator + grounding validator + admin | p50 TTFT < 400 ms; validator failure < 1%; loader < 15 KB |
| **2 — Trust** | 4 wks | Attribution chain, holdout, merchant ROI dashboard | Incrementality report renders on a live pilot store |
| **3 — Voice** | 6 wks | Voice lane, semantic endpointing, barge-in | p50 mouth-to-ear < 500 ms |
| **4 — Scale** | 4 wks | Multi-region, tenant isolation, budget ladder, chaos tests | 10× peak load test green; region failover < 30 s |
| **5 — Launch** | 3 wks | Built for Shopify review, docs, pricing, CWV certification | Zero CWV regression on 5 pilot stores |

**Do not build voice in phase 1.** It is the demo, not the wedge. Text-first proves grounding, latency, and attribution — the three things that actually retain merchants — and voice then lands on a foundation that can carry it.

---

## 13. Pricing recommendation

| Plan | Price | Resolved conversations | Notes |
|---|---:|---:|---|
| Free | $0 | 100/mo | **Unlimited SKUs.** Full feature set. |
| Growth | $49/mo | 500 | |
| Scale | $199/mo | 2,500 | + human handoff |
| Plus | $599/mo | 10,000 | + voice, API, priority routing |
| Overage | $0.06 each | — | |
| *Performance* | *1.5% of attributed incremental revenue* | unlimited | *Alternative to subscription; requires holdout* |

Three deliberate departures from SiteAgent:

1. **Bill per resolved conversation, not per message.** Per-message billing makes the merchant hope the product goes unused. Per-resolution aligns us with outcomes.
2. **Unlimited SKUs at every tier**, including free. Only possible because we don't index the catalog (§4) — an architectural advantage converted directly into a pricing advantage competitors cannot copy without a rewrite.
3. **A free tier generous enough to prove value.** 100 resolutions is enough for a small store to see real conversion data. SiteAgent's 400 *messages* (~50 conversations) is too thin to demonstrate anything.

Net: roughly **4–6× cheaper than SiteAgent** at comparable volume, competitive with Zipchat, and a fraction of Gorgias — at ~78% gross margin.
