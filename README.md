# StoreAgent

An AI shopping assistant for Shopify that **never makes things up, never slows your store down, and proves what it earned you.**

Built as a direct answer to the gaps in [SiteAgent AI](https://apps.shopify.com/siteagent-ai) and the wider Shopify AI-chat category.

---

## The three claims

| Claim | Mechanism | Competitor gap it closes |
|---|---|---|
| **Never wrong** | Live Shopify UCP catalog + citation-enforced grounding validator | Rivals embed a stale catalog copy and cap you at 500–3,000 products |
| **Never slow** | < 15 KB loader · < 350 ms first token · < 500 ms voice · 0.00 CLS | Chat widgets are a top cause of Core Web Vitals failure |
| **Provably worth it** | Permanent 5% holdout → real incrementality, not "influenced revenue" | Nobody in the category runs a control group |

Plus: **unlimited SKUs on every tier including free**, and roughly **4–6× cheaper** than SiteAgent.

---

## Documentation

| Doc | Contents |
|---|---|
| [`docs/EXPERIENCE-CONTRACT.md`](docs/EXPERIENCE-CONTRACT.md) | **Start here.** The non-negotiable bar for fast / smooth / friendly, and the CI gates that enforce it |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | SiteAgent teardown, nine exploitable weaknesses, competitive landscape, positioning |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System topology, UCP integration, grounding layer, latency engineering, model strategy & unit economics, multi-tenancy, attribution, build sequence, pricing |
| [`docs/UX-PERFORMANCE.md`](docs/UX-PERFORMANCE.md) | Performance budget, load strategy, conversation surface, voice UX, accessibility, edge states |

Enforcement config lives in [`perf/`](perf/) — `size-limit.json` and `lighthouse-budget.json` wire the contract into CI.

---

## Key architectural decisions

1. **UCP-native from commit one.** All catalog and cart traffic goes to `POST https://{shop}/api/ucp/mcp`. Legacy Storefront MCP cart tools lost support on **2026-08-31** — competitors on `/api/mcp` are breaking now.
2. **Never own the catalog.** Live `search_catalog` / `lookup_catalog` / `get_product` per request. Deletes an entire cost center, removes staleness, and makes unlimited-SKU pricing possible.
3. **Grounding in code, not in the prompt.** The model emits prose *and* a machine-checkable claim set; a deterministic validator verifies every price/stock/policy assertion against this turn's tool results.
4. **Speculative tool execution.** Catalog search fires in parallel with the model request, not after it asks — collapsing the dominant latency cost and letting product skeletons render before the sentence finishes.
5. **Adaptive thinking stays ON, `effort` goes to `low`.** Disabling thinking on Sonnet 5 makes it measurably less likely to call tools — which would silently degrade the grounding we're selling. Effort is the latency lever; thinking is not.
6. **Prompt caching is the business model, not an optimization.** ~$84k/mo of model spend at 9M turns becomes ~$310k/mo without it.
7. **Text first, voice second.** Voice is the demo; grounding, latency, and attribution are what retain merchants.

---

## Stack

**Widget** Preact + signals, Shadow DOM, Vite · **Admin** Remix + Polaris + App Bridge
**Edge** Cloudflare Workers + KV · **Gateway** Go · **Orchestrator** TypeScript
**LLM** OpenAI, behind a provider-neutral `ModelClient` seam · **Voice** LiveKit + Deepgram Nova-3 + Cartesia Sonic
**Data** Postgres 17 + pgvector · Redis Cluster · ClickHouse · S3

---

## Status

**Phase 0 complete — gate passed.** ✅ See [`docs/PHASE-0-FINDINGS.md`](docs/PHASE-0-FINDINGS.md).

`packages/ucp-client` ships a UCP-native client for all seven tools plus `SafeCart`, which makes `update_cart`'s destructive PUT semantics survivable. 42/42 tests green, clean typecheck, 0 production vulnerabilities, all latency budgets met.

```bash
npm install
npm test          # 42 passed
npm run typecheck
npm run bench     # per-tool latency vs budgets
```

**Phase 1 is blocked on one thing:** verify the `meta.ucp-agent.profile` key encoding against a live development store (OPEN-QUESTION #1). Every request carries that field — it's the highest-risk unknown and the cheapest to check.
