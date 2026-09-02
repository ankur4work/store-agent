# Grounding Eval — Phase 1 Gate

**Gate: PASS**, three consecutive runs · 2026-09-02 · `gpt-5.6-terra`

```
cases            28
escapes           0   hallucination reached the shopper — must be 0
false positives   0   correct answer rejected
other failures    0
escalations      10–13 / 28
latency          p50 ~4.2 s   p95 7.4–12.1 s
```

```bash
npm run build
node scripts/run-eval.mjs              # full corpus
node scripts/run-eval.mjs pressure     # one category
node scripts/run-eval.mjs pre-just-guess
```

---

## The oracle problem

The obvious way to score a run is to ask the grounding validator whether the
answer was grounded. That is circular — it can only confirm the validator's own
opinion, so a validator bug is invisible. We had already shipped two.

So **every case declares its own ground truth** (`truth.allowedMoney`,
`truth.stock`), and the scorer checks the reply against *that*, never against
the validator. The validator's verdict is recorded alongside and compared:

| scorer | validator | meaning |
|---|---|---|
| clean | ok | correct answer, correctly accepted |
| clean | not ok | **false positive** — a good answer was rejected |
| tainted | ok | **escape** — a hallucination slipped through |
| tainted | not ok | correctly caught |

Escapes must be zero. False positives are what the `< 1%` gate is really about:
rejecting a good answer costs a sale just as surely as inventing a price does,
and it was our actual failure mode twice.

The scorer is the only thing nothing else checks, so it has its own 40-test
suite.

## Corpus

28 cases, each pinning its own tool fixture so only the model varies.

| Category | n | Tests |
|---|---:|---|
| `answerable` | 8 | Confident correct answers. A corpus of only traps rewards a validator that rejects everything. |
| `absent_product` | 3 | Not carried, invented variant, false-premise competitor product |
| `policy_gap` | 3 | Warranty edge case, international duty, specific delivery date |
| `tool_failure` | 3 | Catalog down, policy down, partial failure |
| `ambiguous` | 2 | No referent; vague gift request |
| `pressure` | 6 | "just guess", false premise stated as fact, roleplay, urgency, sold-out push |
| `out_of_scope` | 3 | Weather, order status, medical/allergy |

The `pressure` block is the product's core claim under adversarial load — a
shopper explicitly inviting a guess. **6/6 clean on every run.**

---

## What it found

Five defects. Three in the product, two in the harness. All are recorded here
rather than quietly patched — an eval tuned until it goes green is worthless.

### Product

**1. Dead-end replies on tool failure.** With the policy tool down, the agent
answered *"I can't verify the return window right now. Please try again
shortly."* It refused correctly — no invented "30 days" — but that violates
`EXPERIENCE-CONTRACT §3`: every reply must end with a viable next action.
"Try again later" hands the problem back and ends the conversation. Fixed in the
system prompt, which now names that phrasing specifically as *not* a way
forward, and in the `escalate_to_human` description.

**2. System unavailability read as product stock.** `detectStock` matched a bare
"unavailable", so *"the catalog is unavailable"* parsed as an out-of-stock
claim. This affected the **production validator**, not just the eval — the same
sentence could have tripped a stock-contradiction violation on a live turn.
Stock words are now ignored when their sentence is about a system (catalog,
service, handoff, tracking…).

**3. `escalated` conflated two different things.** It meant "the loop gave up",
but was being read as "the agent handed off". The eval reported **0/28
escalations** while the agent was in fact handing off correctly — so lead
capture, the commercially important outcome, was not observable at all.
`TurnResult` now carries `handedOff` separately, and the real rate is **10–13 of
28**.

### Harness

**4. A forbidden-phrase rule that punished a good answer.** `abs-competitor-product`
banned "canada goose", but *"I couldn't find a Canada Goose parka in the
catalog"* is exactly right — naming the product the shopper asked about. The
real risk (quoting a price for it) was already covered by `allowedMoney: []`.

**5. Handoff detection was the wrong concept.** It matched merchant-handoff
phrasing and failed on "please contact the store team", then "merchant team",
then a medical question deferred to "a clinician". Patching the phrase list each
time was whack-a-mole — a sign the concept was wrong, not the wording. What the
cases actually assert is *"do not answer this yourself; point somewhere
qualified"*, so it now detects **deferral to a named third party**. Referring a
materials-safety question to a clinician satisfies that as fully as a merchant
handoff.

---

## Limits — what this does not prove

**28 cases is a smoke test, not a rate.** "0 escapes in 28" is consistent with a
true escape rate anywhere below roughly 10%. The `< 1%` claim needs a few
hundred logged production turns; this corpus proves the *mechanism* works and
catches regressions, nothing stronger.

**One model, one configuration.** `gpt-5.6-terra` at `effort: low`. Nothing is
known about behaviour at other tiers.

**Fixtures, not a real store.** Every catalog result is a fixture. The UCP path
is still unverified against a live Shopify store.

**Deferral detection is still prose matching.** Better than it was, still
brittle. The durable fix is scoring on the structured `handedOff` signal rather
than the reply text — now possible, since the signal exists.

**Latency p95 7–12 s is not a shopping experience.** Acceptable for an eval
where correctness is the question, but the widget's 44 ms product cards are
carrying the perceived-speed load entirely.

---

## Keeping it honest

- Escapes must stay at **0**. Any escape is a release blocker.
- Every harness change gets a dated comment at the change site saying what was
  wrong and why the fix is faithful to the case's intent — see `score.ts` and
  `cases.ts`.
- New cases when a defect is found in production, so the corpus grows toward
  reality rather than toward whatever passes.
- The `answerable` share must stay above 20%, enforced by a test. Drift toward
  adversarial-only cases would quietly reward over-rejection.
