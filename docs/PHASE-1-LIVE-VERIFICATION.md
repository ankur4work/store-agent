# Live Verification — OpenAI, 2026-09-01

First run of the orchestrator against a real model endpoint. Everything before
this was scripted mocks.

**Result: the loop works end to end — and it found three defects no mock could.**

```
reply     : "The Merino Wool Overcoat is a full-length, water-resistant wool coat
             for $189.00. Sizes S and M are available. Size L is sold out.
             Want me to add S or M to your cart?"
attempts  : 1
grounding : PASS
tools     : search_catalog -> get_product   (speculation HIT)
usage     : in 3881 / out 215 / cacheRead 2389
latency   : 6327 ms total (non-streaming, 2 tool round trips)
```

Correct price (18900 minor units → `$189.00`), correct per-variant stock, and it
closes with a next action — the no-dead-ends rule from `EXPERIENCE-CONTRACT §3`
holding without being separately enforced.

---

## Defect 1 — strict function schemas rejected outright

```
400: Invalid schema for function 'add_to_cart': 'required' is required to be
     supplied and to be an array including every key in properties.
     Missing 'quantity'.
```

OpenAI strict mode requires `required` to list **every** property and
`additionalProperties: false` everywhere. Our provider-neutral tool defs use
genuinely optional parameters.

**Fix:** `toStrictSchema()` in the adapter — keep every key required, widen
originally-optional types to include `null`, recurse through objects and array
items. `stripNulls()` converts `null` back to "omitted" on the way in.

Dropping `strict` was the easy fix and the wrong one: invalid tool arguments
produce bad tool calls, bad tool calls produce ungrounded answers, and that is
the exact failure this product exists to prevent.

**Also required a tool-definition change.** `get_product.selected` was an open
map (`additionalProperties: {type: "string"}`), which strict mode cannot
express. It is now an array of `{name, value}` pairs — expressible on every
provider.

## Defect 2 — tools and reasoning effort are mutually exclusive on Chat Completions

```
400: Function tools with reasoning_effort are not supported for gpt-5.6-terra
     in /v1/chat/completions. To use function tools, use /v1/responses or set
     reasoning_effort to 'none'.
```

We need both: every turn is tool-driven (tool-calling rate *is* grounding rate)
and effort is the latency/cost lever from `ARCHITECTURE.md §7.2`.

**Fix:** the adapter targets **`POST /v1/responses`**, not Chat Completions.
Different wire shape throughout — `instructions` instead of a system message,
`input` instead of `messages`, flat function tools with no nested `function`
object, `reasoning.effort`, `text.format`, and an `output` array of
`message` / `function_call` / `reasoning` items.

## Defect 3 — the grounding gate was rejecting correct answers ⚠️

The most important finding, and invisible to every mock.

First live run: `attempts: 2`, `grounding_retry(unknown_citation ×3)`, and a
final reply of *"I can't verify the wool-coat sizes or price from the
information available here."* — with the catalog data sitting right there in the
tool results.

**Cause:** the grounding contract asked the model to cite
`source_tool_call_id`, and the orchestrator recorded the provider's opaque ids
(`call_CxYz9f…`). Models reproduce those unreliably. Every citation missed, so
grounding failed a **correct** answer, and the retry feedback ("don't state
facts you can't ground") pushed the model into a needless refusal.

Net effect: the mechanism built to prevent hallucination was destroying good
answers and manufacturing escalations. Worse than a cosmetic bug.

**Two fixes, both principled:**

1. **Cite short deterministic handles, not provider ids.** Tool results now
   carry `{ source: "search_catalog#1", data: … }` and the schema tells the
   model to copy that handle exactly. Models reproduce `search_catalog#1`
   reliably.

2. **Severity now tracks actual risk.** An unknown citation whose facts *are*
   independently supported by this turn's tool results is a **warning**
   (mislabeled citation), not an error. Only an unknown citation with
   *unsupported* facts is an error. This is safe because the coverage checks
   independently catch fabricated prices and stock regardless of what was
   declared — citation checking was always the secondary net.

After both: one attempt, grounding passes, correct answer.

---

## Confirmed working

| | |
|---|---|
| Adapter request/response shape | ✅ accepted by the live API |
| Strict structured outputs | ✅ model emits well-formed `reply` + `claims` |
| Grounding validator on real output | ✅ passes a correct answer, no false positive |
| Speculative catalog search | ✅ `speculation_hit` — model's query matched the prefetch |
| Minor-unit conversion | ✅ 18900 → `$189.00` |
| Per-variant stock accuracy | ✅ S/M available, L sold out |
| Automatic prompt caching | ✅ `cached_tokens` 2389 of 3881 input (~62%) |

**Model ids verified** against `GET /v1/models`: `gpt-5.6-luna` (classify),
`gpt-5.6-terra` (workhorse), `gpt-5.6-sol` (escalation) all exist. Still
env-overridable via `resolveModels()`.

---

## Open concerns

**Latency is far off target.** 6.3 s total against a p50 TTFT budget of 350 ms.
Not yet alarming — this is non-streaming, two sequential tool round trips, a
reasoning model at `low` effort, and no gateway. But it means the TTFT gate is
entirely unproven and streaming is now the critical path, not a nicety.

**Cache hit was ~62% on a cold-ish prefix.** Worth re-measuring across a warm
multi-turn session; the prefix-stability guard is doing its job but the number
needs a real baseline.

**One live turn is not an eval.** Grounding passed on a single happy path. The
`validator failure < 1%` gate needs a few hundred logged turns with adversarial
inputs, not one smoke test.

~~**Voice: a speech-to-speech realtime model could collapse the Phase 3
STT → LLM → TTS pipeline into one hop.**~~ **Evaluated and rejected in Phase 3.**
It would collapse the grounding with it: speech-to-speech emits audio, so there
is no structured output to validate, no claims to check, and no text stream for
the tripwire — and audio cannot be retracted. A hallucinated price that has been
spoken is already in the shopper's ear. See `PHASE-3-VOICE.md`.

---

## Reproducing

```bash
npm run build
node scripts/smoke-openai.mjs [model-id]     # default: gpt-5.6-terra
```

Reads `OPENAI_API_KEY` from `.env` (gitignored). Never logs the key.
