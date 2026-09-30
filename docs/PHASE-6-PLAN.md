# Phase 6 — Listening quality, and the agent around it

**Date:** 2026-09-30 · **Status:** plan, nothing built yet
**Goal in one line:** the shopper speaks and is understood, on the first try,
on a phone, in a noisy room — and everything downstream of the transcript gets
faster and more deliberate.

Five levels. Each one ends at a **gate**: a measurement plus a thing you do by
hand on the dev store. Nothing starts on level N+1 until the level N gate is
green and you have said so.

---

## 0. What already exists (read this first)

A large part of the requested architecture is built. This plan is a delta, not
a rewrite. Where a request is already satisfied, the honest answer is "no work"
rather than a rebuild that ships risk and no capability.

| You asked for | Today | Phase 6 work |
|---|---|---|
| Voice input: Whisper via Transformers.js + WebGPU, server fallback | Server-only: mic → WAV upload → `gpt-4o-transcribe`, `whisper-1` fallback (`gateway/src/voice/service.ts`) | **Level 2** — local first rung, server stays the floor |
| AI brain: LLM with tool/function calling | Built — hand-rolled loop, 5 tools, mid-stream grounding tripwire (`packages/orchestrator`) | Level 3 adds a deterministic lane *around* it |
| Product search: Shopify API + own semantic search | Built — UCP MCP `search_catalog` + own 1536-dim embedding index with a 0.3 score floor, incl. vision-described images (`gateway/src/search/*`) | Level 5: webhook-driven freshness. Storefront API: **declined**, see §0.2 |
| Vector search: pgvector + Postgres/Supabase | `VectorStore` interface, SQLite implementation, brute-force cosine (~10 ms at 5k vectors) | **Level 5, gated** — see §0.1 |
| Agent backend: Node.js + TypeScript | Built, Node 22, zero runtime dependencies | no work |
| Streaming: SSE or WebSockets | Built — SSE, and product cards already stream *before* the prose (~44 ms) | no work |
| Conversation state: Redis | `SessionStore` is already Redis-shaped (async, TTL, string keys); SQLite behind it | **Level 5, gated** |
| Catalog sync: webhooks + background workers | Missing. Index rebuilds on 6 h staleness or on a suspicious miss | **Level 5** — build it |
| Analytics: PostHog or own events | Own: Prometheus `/metrics`, `/api/slo`, attribution + holdout tables | **Level 5** — own funnel. PostHog: see §0.3 |
| WebMCP, not depended on | Not present | Level 5, additive namespace only |
| UI: floating assistant, cards not text, next-choice chips | Built — square listening box, image-forward card rail above the prose, chip row, skeletons, Shadow DOM both ways | **Level 4** — card *actions* and per-turn chips |
| Salesman brain prompt | Mostly built — `orchestrator/src/prompt.ts` already carries 13 of your 14 rules | **Level 3** — merchant-specific pack, which is a stub today |
| Not every response is an LLM call | Not true today. Every turn hits the model | **Level 3** — deterministic lane |

### 0.1 pgvector / Supabase — deliberately deferred, not forgotten

Three reasons, in order of weight:

1. **It would make search slower.** Brute-force cosine over a Shopify catalog
   (hundreds of products; thousands at the top end) is ~10 ms in-process. A
   Supabase round trip is 30–80 ms before it does any work. You would pay
   latency to gain an index you do not need until ~100k vectors.
2. **It breaks the holdout.** This deployment is deliberately single-node
   SQLite because two writers corrupt holdout assignment silently, and
   incrementality is the thing the product is sold on. Moving to Postgres is
   the right move *when multi-node is the goal*, and then holdout assignment
   has to move into the shared store first — that is a Level 5 task with its
   own gate, not a side effect of changing a vector store.
3. **The seam already exists.** `VectorStore` has four methods. A pgvector
   implementation is a file, not a migration of call sites. Writing it early
   buys nothing; the interface is the part that mattered and it is done.

**Trigger to build it (any one):** a merchant catalog over 25k products; a
second gateway node becomes necessary; or p95 semantic search exceeds 40 ms.
Level 5 includes the implementation behind that trigger so it is ready.

### 0.2 Shopify Storefront API — declined for now

UCP MCP already does natural-language catalog search and returns per-variant
price and availability, and the `update_cart` full-replacement semantics are
already handled with hostile fixtures. Adding the Storefront API duplicates
that surface, needs a second scope (`unauthenticated_read_product_listings`)
and a storefront access token per shop, and gives us one thing we cannot get
today: metafields and tag-level filtering.

If a merchant needs filtering on metafields, this becomes a Level 4 add-on
scoped to *that*. Building it now is a parallel integration to keep in sync
with no shopper-visible gain.

### 0.3 PostHog — recommend own events

PostHog on a storefront is a third-party data processor observing shoppers who
never agreed to it. That means: a `PRIVACY.md` rewrite, a Shopify App Store
data-disclosure change, a GDPR processor entry, and bytes on the merchant's
page against a CWV contract we currently pass. The funnel you actually want
(opened → engaged → cards shown → card clicked → add to cart → checkout) is
six columns in a table we already own, joined to a holdout arm nobody else
has. Level 5 builds that. PostHog stays available as a merchant-side opt-in if
one ever asks.

---

## 1. Level 1 — Make listening measurable, then take the free wins

**Why first.** "Improve listen quality" is not yet a falsifiable statement
about this app. There is no word-error-rate number, no count of how often a
transcript is discarded, and no latency breakdown of a voice turn. Every later
level is judged against Level 1's baseline, and two of the levels can be
cancelled by what it measures.

### Build

1. **A voice eval harness** — `packages/voice/test/fixtures/` plus a runner in
   `packages/eval`, mirroring the existing 28-case grounding eval.
   - ~30 utterances: short ("how much"), long, mid-sentence pause, accented,
     background noise, music, two people, and **four silence/noise-only
     clips** whose correct answer is the empty string.
   - Baseline clips are generated from our own TTS (repeatable, free) and
     clearly labelled as such — synthetic audio flatters a recogniser. Then
     8–10 real recordings from a phone, committed as 16 kHz mono WAV.
   - Scores: WER, fabrication rate (a transcript where silence was the truth),
     discard rate, language-mismatch rate, p50/p95 time-to-transcript.
2. **Instrument the live path** — counters in `observability/metrics.ts` for
   each existing outcome that is currently invisible: `heard`, `empty`,
   `prompt_echo`, `language_mismatch`, `fallback_rescued`,
   `fallback_unusable`, `discarded_silence`. Today these are log lines; a rate
   cannot be read from log lines.
3. **Capability census from the widget** — one field on the existing
   `/api/diag` beacon: WebGPU adapter present, `deviceMemory`,
   `connection.effectiveType`, `saveData`, `AudioWorklet` support, whether
   `SpeechRecognition` exists. **This number decides Level 2's default.** If
   under ~30% of this store's voice sessions have a usable WebGPU adapter,
   local Whisper is a desktop accelerator, not the primary path — and the plan
   changes accordingly rather than shipping on an assumption.
4. **Free wins, in the current server path** (no new dependency, no new asset):
   - **Capture PCM directly** via `AudioWorklet` instead of
     MediaRecorder-webm → `decodeAudioData` → re-encode WAV. Removes a decode
     pass and a whole-utterance buffer wait from every turn.
   - **Start uploading while they are still speaking.** Today the upload
     begins after endpointing. Chunk it and the network time overlaps the
     speech instead of following it.
   - **Explicit mic constraints**: mono, 16 kHz, `echoCancellation`,
     `noiseSuppression`, `autoGainControl` stated rather than left to the
     browser's defaults, which differ per browser and per OS.
   - **Noise-floor calibration.** The silence threshold is a fixed energy
     value today; calibrate it over the first ~300 ms of the turn so a noisy
     room raises the floor instead of holding the mic open.
   - **`preconnect` to the gateway** on mic press, so the TLS handshake is not
     inside the shopper's turn.

### Will NOT do at this level

No new dependency. No model download. No change to the transcript→answer path.

### Status — built 2026-09-30, one gate outstanding

Everything in this level is written and tested; 1,196 tests pass and the widget
budget gate is green at 14.39 KB of 15 KB. What is **not** done is the
measurement, and for a reason outside the code:

> The OpenAI account returns `billing_not_active` as an HTTP 429. No
> transcription, TTS, embedding or model call can succeed, so there is no
> baseline yet. The harness runs end to end regardless — it generated clips,
> uploaded them, scored them, gated, and wrote `eval-results/listening.json`.

| Landed | Where |
|---|---|
| WER scorer, corpus WER weighted by words, fabrication counted separately | `packages/voice/src/transcript-score.ts` |
| 16 kHz WAV encode/decode + anti-aliased resample | `packages/voice/src/wav.ts` |
| Seeded room/music noise, SNR mixing | `packages/voice/src/noise.ts` |
| 24-clip corpus over 7 groups, 3 degradation variants | `packages/voice/src/listening-corpus.ts` |
| Runner with `--rate`, `--group`, `--real`, `--save-baseline` | `scripts/check-listening.mjs` |
| Per-outcome counters, transcribe duration, upload bytes | `observability/telemetry.ts`, `voice/service.ts` |
| Device census → bounded-label counter | `widget.js` → `/api/diag` |
| AudioWorklet PCM capture, 16 kHz upload, calibration window, preconnect | `packages/gateway/public/widget.js` |

Three defects were found and fixed on the way:

1. **An unpaid account was indistinguishable from mishearing.** It arrives as an
   HTTP 429 — the same status as a rate limit — and was reported as
   `transcription failed`. It is now classified as `upstream_unpaid`, counted
   separately, and no longer spends the acoustic-model fallback request that
   cannot succeed either. Verified live: `storeagent_transcripts_total{outcome="upstream_unpaid"} 1`.
2. **Tapping the mic off submitted the recording.** `MediaRecorder.stop()` fires
   `onstop` asynchronously, after `voice.on` is cleared, and the handler
   uploaded anything over 1200 bytes — so a visibly cancelled half-sentence was
   answered anyway. Cancelling now discards; only the endpointer submits.
3. **The MediaRecorder fallback uploaded at the microphone's native rate**,
   paying 3× the bytes for audio no recogniser reads at that rate. It now shares
   the same 16 kHz path.

Measured, not asserted: the upload is **31 KB per second of audio against 94 KB**
before (`check-listening.mjs --rate 48000` reproduces the old behaviour).

### Gate

- `npm run check-listening` prints a baseline table, then an after table.
  Required: **WER down, p95 time-to-transcript down by ≥ 25%, and 4/4 silence
  clips return empty** (zero fabrications). **Blocked on the billing account.**
- Every new counter appears in `/metrics` with a non-zero sample after a real
  voice turn.
- **You, on the dev store, on a phone:** five spoken questions in a normal
  room. You tell me how many were understood first try, and whether it feels
  faster. If it does not, Level 1 is not done — the numbers are a proxy, your
  ear is the gate.
- Rollback: all of this is behind the existing voice path; reverting is one
  commit.

---

## 2. Level 2 — local recognition for the live caption, server still the authority

### Status — restructured 2026-09-30 on three measurements

The plan below assumed local Whisper would be the transcriber. Measuring the
actual assets changed that, and the level was rescoped **before** building:

| Asset | Measured |
|---|---|
| whisper-tiny multilingual, fp16 (what WebGPU wants) | 72.6 MB |
| whisper-tiny multilingual, int8 | 39 MB |
| whisper-base fp16 | 139 MB — not viable on a storefront |
| ONNX runtime `ort-wasm-simd-threaded.jsep.wasm` | **27 MB** |
| `transformers.web.min.js` | 0.45 MB |
| **Total, first use, int8 + WebGPU runtime** | **~69 MB** |

Two conclusions the earlier estimate of "~40 MB" hid:

1. The runtime is as big as the model. A 69 MB first-use download cannot be the
   default path on a storefront.
2. **whisper-tiny is less accurate than `gpt-4o-transcribe`**, and markedly so
   for Hindi, Arabic and Urdu — languages this merchant's `VOICE_LANGUAGES` list
   already offers. Level 1's own gate (local WER ≤ server WER) would refuse to
   ship it as the transcriber.

What local recognition is genuinely good for here is the **interim** transcript.
That is what `endpoint.ts` reads to tell a pause mid-sentence from the end of a
question, so it decides how often a shopper gets cut off — the largest
real-world cause of a mangled turn. Partial accuracy does not have to beat the
server, because the server still produces the answer.

And the browser will now do exactly that for free. Chrome ships
`SpeechRecognition.processLocally` with `available()` / `install()` and
**browser-managed language packs**: local recognition, private, zero bytes from
us. So the ladder is:

| Rung | Live caption from | Cost to the shopper |
|---|---|---|
| 1 | On-device Web Speech (`processLocally: true`) | **0 MB** |
| 2 | Cloud `SpeechRecognition` (the previous behaviour) | 0 MB |
| 3 | Whisper via Transformers.js + WebGPU — merchant opt-in | ~69 MB |
| — | **Final transcript: always the server** | unchanged |

Rung 3 keeps its place for the cases rungs 1–2 cannot serve — Firefox, and a
merchant who will not have speech touched by a third party — but as a deliberate
choice rather than a default.

### Built (rungs 1–2, and the split that unblocks rung 3)

- **`processLocally = true` is a requirement, not a hint**: the recogniser
  refuses rather than silently using the cloud, which is what makes the privacy
  claim in the admin copy true. Availability is probed once per page and never
  awaited on the path to the chime — the first turn behaves exactly as before,
  later turns use what the probe found. One retry to cloud if the pack was
  evicted since.
- **Language packs install between turns only**, when the merchant opted in,
  never on `saveData` or a slow connection.
- **`onDeviceSpeech` setting** — `off | auto | on`, migrated in SQLite and
  Postgres, rendered in the admin with the download cost stated, carried in
  `/api/config`. `auto` (the default) downloads nothing.
- **`storeagent_voice_partials_total{kind,mode,state}`** — `cloud`+`downloadable`
  (merchant has not enabled installs) and `cloud`+`error` (a Permissions-Policy
  is blocking us) need opposite fixes and are otherwise indistinguishable.
- **The widget is split**, which `ARCHITECTURE §3.1` asked for and never got:

  ```
  widget.js        10.18 KB gz  — every page view  (was 14.91 of a 15 KB gate)
  widget-voice.js   5.84 KB gz  — first mic press  (40 KB gate)
  ```

  One file had been carrying loader, panel and voice against the loader's own
  budget, with 79 bytes left. A shopper who never presses the microphone now
  downloads none of it, and rung 3 has 34 KB of room for its loader. The seam is
  eight calls each way; `els` and `state` cross as references and `CONFIG` as an
  accessor, because it is reassigned when `/api/config` answers.

  The split's sharpest edge was caught by an existing test: `x-storefront-lang`
  moved into the chunk, and a header the server does not advertise fails the
  CORS preflight invisibly. That scan now covers both bundles.

### Still to build

Rung 3, and the pinned, integrity-verified vendoring it needs. The registry
integrity hash for `@huggingface/transformers@4.3.0` was verified to match
before any of this was designed, and the weights are to be baked into the Docker
image rather than fetched at boot.

---

## 2b. Original Level 2 sketch — Whisper as the transcriber (superseded)

### The design, which differs from the sketch in one important way

A cold local Whisper is a **~40 MB download** (whisper-tiny int8; base is
~80 MB) plus ~1.5 MB of runtime. A first-time shopper on mobile data cannot
pay that inside their first sentence, and the widget's enforced budget is
15 KB gzipped for what ships on every page view. So the ladder is:

```
turn 1   mic → server STT  (fast, known, already works)
         ↓  in the background, after the turn succeeds
         prefetch model IF: WebGPU adapter present
                        AND not saveData
                        AND effectiveType is 4g/wifi-class
                        AND Cache Storage has room
turn 2+  mic → local Whisper (streaming partials, no upload at all)
         ↓  if not ready within 250 ms, or it errors
         server STT — same as turn 1, shopper notices nothing
```

Local Whisper is therefore an **accelerator that engages when it is free**,
never a gate the shopper waits behind. The wasm path is kept only as a
last resort when the server is unreachable, because multi-threaded wasm needs
cross-origin isolation (COOP/COEP) that we cannot impose on a merchant's page
— single-threaded wasm transcription is too slow to be a real rung.

### Build

- **New lazily-fetched asset**, `packages/gateway/public/voice-local.js`,
  bundled by `scripts/build-widget.mjs` as a second entry point with its own
  budget. It is `import()`ed on first mic press and never referenced from the
  loader, so `widget.min.js` stays under its 15 KB gate. `transformers.js` is
  bundled at build time, not pulled from a CDN — external hosts are both a CSP
  problem on merchant storefronts and against this repo's zero-CDN posture.
- **Self-hosted weights** under `/voice-models/…`, served by `serveStatic`
  with immutable long cache, correct `application/wasm` and `application/octet-stream`
  types, CORS for the merchant origin, and no gzip on already-compressed
  weights. Persisted in Cache Storage keyed by model + revision.
- **Streaming partial transcripts**, which is the real listen-quality win:
  the tested semantic endpointer in `packages/voice/src/endpoint.ts` — which
  runs server-side today and is wired to nothing — finally runs in the browser
  against a real interim transcript, replacing the Chrome-only
  `SpeechRecognition` hint and the conservative energy thresholds. This is the
  "next voice latency win" that `STATUS.md` names.
- **A ladder with a budget**: local → server → local-wasm → "didn't catch
  that". Every rung reports which one produced the transcript, as a metric.
- **A merchant switch** in admin settings: on-device transcription on / off /
  auto, defaulting to whatever Level 1's census says is right for this store.

### Will NOT do

No removal of the server path. No blocking the first turn on a download. No
COOP/COEP demands on the merchant's page. No CDN.

### Gate

- **Automated:** the Level 1 eval runs against the local engine too, and local
  WER must be **≤ server WER** on the fixture set. Widget size gate still
  green: `widget.min.js` unchanged within 200 bytes.
- **You, on desktop Chrome:** open DevTools → Network, do a voice turn (the
  second one). Expect **zero requests to `/api/voice/transcribe`**, partial
  text appearing while you are still talking, and the answer starting sooner
  than it does today.
- **You, on a phone:** voice still works. If the phone takes the local path,
  it must not be slower than Level 1; if it takes the server path, it must be
  exactly Level 1. Either outcome passes — silently degrading to something
  worse than Level 1 does not.
- **Cold shopper simulation:** clear site data, first voice turn must still
  answer in Level-1 time. This is the one that catches a plan that quietly put
  a 40 MB download in front of a shopper.
- Rollback: the merchant switch set to `off` restores Level 1 exactly, with no
  deploy.

---

## 3. Level 3 — A deterministic lane, and a merchant's own salesman brain

### Status — built 2026-09-30

All three pieces landed. 1,313 tests pass; both widget budgets green; launch
check passes.

**The deterministic lane** (`orchestrator/src/intents.ts`, wired in
`server.ts:answerWithoutModel`). Recognised turns are answered with no model call
at all — measured under 500 ms end to end over HTTP, with
`storeagent_model_tokens_total` provably flat.

The rule that makes it safe is worth restating, because it shaped everything
else: **a local filter may only ever narrow a set the shopper is already looking
at, and an empty result is never reported as "no matches".** "Do you have these
in blue" looks exactly like a colour filter and is not — the blue one may exist
and simply not be among the six results on screen, so answering from the visible
set would tell a shopper the store does not stock something it does. Those turns
go to the model, which can search. The same fallthrough covers the number parser
being wrong: a mis-read amount filters everything out and lands there.

Declines are counted as well as answers (`storeagent_fast_lane_total`), because a
lane that keeps handing turns back has patterns that are wrong, and counting only
its successes would make that look like idleness.

**The merchant pack** (`settings.merchantPackFrom`). Every shop shared one
hardcoded prompt, which was not merely a missing feature: it claimed "Free
shipping over $75", so shoppers of stores that have never offered free shipping
were being told they had it. Brand voice, policy notes, promoted products and a
never-recommend list are now per shop.

Two details that matter more than they look:

- Merchant free text is checked for dates, times and ids **when they save**.
  `assertStable` rejects those because they make the cached prefix unique per
  turn — which multiplies model spend by roughly ten, silently. "Sale ends
  2026-12-24" is a completely reasonable thing for a merchant to type, so they
  get a message naming the cost and offering the fix rather than a shopper's turn
  throwing.
- The merchant's rules are rendered **after** the grounding rules and carry an
  explicit sentence saying they lose to a tool result. A merchant could
  reasonably write "always say the winter coat is in stock"; they must not be
  able to talk the model out of checking.

`storeagent_prompt_prefix_changes_total` now notices a prefix that changes with
traffic — the canary for §7.4's unit economics, which previously failed silently.

**Preference memory** (`orchestrator/src/preferences.ts`). This was the one rule
in the requested list the prompt could not keep: it says never to ask for
something already given, and nothing carried an answer forward. History is capped
at 24 messages, so a size mentioned eight turns ago competes with everything else
in the window — and being asked your size twice is the moment a shopper decides
the thing is not listening.

Extraction is deterministic, and refuses far more than it accepts: "do you have a
large" is about the shop rather than the person asking; "it's £200" is a product
price, not a budget; "is the black one in stock" is a question, not a standing
instruction to only ever show black. A wrong remembered preference is worse than
none, because it silently narrows every later recommendation and the shopper
never learns why. Three such bugs were found by the tests and fixed.

Stored per session for 30 minutes and filtered on the way back out, since this
JSON reaches the model as an instruction about a person. Size, budget, colour and
occasion only — never a name, never anything inferred from behaviour.



### Build

1. **Intent router before the model** (`packages/orchestrator/src/router.ts`
   grows a sibling; the model router already exists). Deterministic, no
   tokens, no round trip:
   - `open cart`, `show my cart`, `checkout`, `go to checkout`
   - `add this`, `add it`, `remove that`, `quantity two`
   - `show blue ones`, `cheaper`, `under fifty` → a filter over the products
     already on screen, not a new search
   - `scroll`, `next`, `back`, `open the first one`
   These emit the **same SSE events** the model path emits, so the widget
   needs no special case, and they cost £0 and ~50 ms. Anything ambiguous
   falls through to the model — the router's default answer is "not mine".
   A regression test asserts that every phrase it claims is genuinely
   unambiguous, because a router that swallows "add this to a wishlist" is
   worse than no router.
2. **Merchant pack wired to reality.** `MerchantPack` (brand voice, policy
   summary, locale, currency) is a typed stub today with nothing feeding it.
   Add admin fields — brand tone, products to promote, products never to
   recommend, discount rules, shipping and returns notes — persisted per shop
   and rendered into the **cached prefix** (per-merchant is cache-safe;
   per-shopper is not). `assertStable()` already guards the prefix; add a
   metric on `prefixFingerprint` so a change that silently kills prompt
   caching pages someone instead of showing up in a bill.
3. **Preference memory.** Size, budget, colour, occasion — extracted
   deterministically from the turn, stored on the session, rendered into the
   turn context. This is your rule 13 ("never ask again for what was already
   given"), and it is the one rule in your list the current prompt cannot
   keep, because nothing carries the answer forward.

### Gate

- **Automated:** `open cart` and `add this` complete with **zero model tokens**
  — asserted in a test and visible as a flat token counter in `/metrics` — in
  under 150 ms. The router's ambiguity test passes. Cached-read tokens stay
  non-zero across turns after a merchant edits their tone (proves the prefix
  is still cacheable).
- **You, in the admin:** set the brand tone to something distinctive, save,
  ask the same question in the storefront, and see the reply change. Set a
  "never recommend" product and confirm it stops being offered.
- **You, in the storefront:** say "I'm a medium", then two turns later ask for
  a jacket. It must not ask your size again.

---

## 4. Level 4 — The multimodal surface

### Status — built 2026-09-30

1,359 tests pass; both budgets green (`widget.js` 10.66 KB of 15 KB);
check-launch passes.

**Chips now come from the products that are actually on screen**, and each one is
**verified against the real filter before being offered** — so it cannot suggest
a colour nothing has, or one that everything has and would therefore do nothing.
That verification is what makes the guarantee real rather than asserted: the chip
cannot disagree with the filter, because the filter is what approved it.

Because the phrases are written to classify, **tapping a chip is answered with no
model call**. A test asserts exactly that for every chip the generator produces,
so a chip that stopped classifying would fail rather than silently start costing
a turn. One colour is offered rather than three — "blue / red / navy" is the same
axis three times and crowded the price options out entirely on the first attempt.

`More like this` is the exception and is deliberately a model turn: it appears
only when a single product leaves nothing to narrow, which is precisely where the
chip row used to be empty and where a shopper most needs a next step.

**Cards can add to the cart**, via `POST /api/cart/add`, and only where a tap can
mean one thing. With two sizes in stock there is no way to know which the shopper
wants and a wrong variant is discovered at checkout — so the button is not
offered and the card stays a link to the product page, where the choice belongs.
That is the same rule the lane applies to "add this" in text; a tap simply does
not carry the ambiguity a sentence does. The confirmation is the server's reading
of the cart, never a total the widget assembled from its own copy of a price.

A **variant picker in the card was declined** rather than built: the product page
already has Shopify's own, which handles per-option inventory correctly, and
reimplementing it in a 156px card would be a worse version of something one tap
away.

**"Something like this but black" now speculates on the right thing.** It used to
search for `something like black` — not a product anyone sells — so the cards
stayed empty and the shopper waited for the model to work out what the page they
were standing on already said. With the product folded in it searches
`black Merino Wool Overcoat`. Only on a product page, and only when they actually
pointed: on a collection page "this" means the collection, and the title is not a
product.

**Barge-in and modality parity were already correct and are now tested** — they
were not before. Speaking over the assistant cancels the audio *and* aborts the
generation behind it (stopping the audio alone leaves the model writing and the
tokens spent), needs more than a cough to trigger, and invalidates speech already
requested so a retracted sentence cannot arrive late. The composer is never
removed in the compact voice box: the rail, chips and intro are hidden there
because they are invitations, but the keyboard is a capability.



The UI you sketched is largely the UI that exists — cards above the prose,
chips, a listening box rather than a chat window. What is missing is that the
cards are currently **read-only**, and the chips come from the page rather than
from the answer.

### Build

- **Card actions:** add to cart from the card, variant picker in place, "more
  like this", open PDP. Cart actions already exist as tools and already have
  the full-replacement `update_cart` safety; this exposes them to a thumb.
- **Per-turn chips generated from the turn's own tool results** — actual
  colours, sizes, price bands and collections present in the results, not
  model-invented categories and not the static page-based set. Deterministic,
  so a chip can never offer something the store does not have.
- **"Something like this but black."** The page context (product id, title) is
  already sent every turn. This makes it *usable*: resolve the current
  product's options and family, then search within it constrained by the new
  attribute, so the answer is siblings rather than a fresh keyword search.
- **Barge-in and modality parity:** speaking over the assistant cancels TTS
  and aborts the in-flight model call; push-to-talk as well as hands-free;
  the text composer never disappears when voice is active.

### Gate

**The exact scenario you described, on the dev store, by hand:**

1. Stand on a product page. Say "something like this but black."
2. Cards appear in under a second, and they are the same kind of product.
3. Tap a card's size, tap add — the cart updates, and the assistant says so.
4. Tap a chip ("casual") — the rail changes with no model call.
5. Interrupt the assistant mid-sentence — it stops within ~50 ms.

Automated backing: an integration test per step, and the CWV/size gates still
green — the widget is a guest on the merchant's revenue and Level 4 is the
level most likely to forget it.

---

## 5. Level 5 — The scale-out pieces, each behind its own trigger

### Status — built 2026-09-30

1,417 tests pass; both budgets green; check-launch passes.

**Catalog freshness now comes from Shopify's webhooks.** `products/create`,
`products/update`, `products/delete` and `collections/update` are subscribed and
declared in the manifest; none needs a scope beyond `read_products` and none
carries protected customer data, so unlike `orders/create` they cannot block a
deploy.

The work is coalesced per shop, which is the part that matters financially: a CSV
import of four hundred products sends four hundred webhooks in seconds, and
rebuilding on each would embed the whole catalog four hundred times — hundreds of
API calls and a bill — to arrive at the index one rebuild produces. The first
change starts a 30 s timer, each subsequent one extends it, and a five-minute
ceiling stops a merchant working steadily through their catalog from deferring
the rebuild for the whole hour. A change arriving *during* a rebuild queues
another, so the index is never quietly one version behind.

The webhook is acknowledged before any of it runs. Re-embedding takes longer than
Shopify's patience, and a slow 200 becomes a retry, which becomes a disabled
subscription.

**The funnel is built and merchant-facing**: saw it → opened it → shown products
→ opened a product → added to cart → bought something, with the held-back arm
beside it. Two properties are enforced rather than assumed:

- **It counts people, not events.** One row per session per step, so a shopper
  who taps six cards is one person who tapped a card. An event stream would
  report six and make the funnel widen in the middle, which is nonsense a
  merchant would rightly stop trusting.
- **A client may only report what the server cannot see.** `card_tapped` is a
  navigation away from us, so the widget reports it; `cards_shown` and `cart_add`
  are recorded from things the server did, and the endpoint refuses them. The
  admin footnote says which figures are observations and which are reports,
  because a merchant making decisions on them deserves to know.

The holdout column is mostly blank on purpose — those shoppers never saw the
assistant, so the gaps are the explanation of what it added.

**pgvector is written and switched off.** `PgVectorStore` implements the same
four-method `VectorStore` and is tested against real PostgreSQL. It deliberately
does *not* use the `vector` extension: that would need an extension a managed
Postgres may not offer and a superuser may have to enable — a deployment
prerequisite for a capability we do not need yet, on a path that must not fail.
Vectors are `BYTEA`, byte-identical to the SQLite encoding, and the cosine still
runs in process, which keeps this a pure storage swap rather than a second
implementation that can disagree.

### A correction to this plan

It listed **"holdout assignment must move into the shared store"** as the
precondition for multi-node. That was wrong. `assignArm` is a pure SHA-256 hash
of `shop:sessionId` compared against a fraction, so two nodes sharing nothing at
all already agree on every session — now pinned by a test that says so.

The real single-node constraint was never the assignment; it was **SQLite having
one writer**, which is a storage problem the Postgres stores already solve. The
one genuine coupling is `holdoutFraction`, which must be read from the shared
settings table and never be a per-node default.

### Not built, and why

- **Redis `SessionStore`.** The plan wanted it for multi-node, and
  `PgSessionStore` already provides that — it exists and is tested against real
  PostgreSQL. What Redis would add beyond it is latency on session reads, which
  has not been measured. Building an unmeasured optimisation for a deployment
  that is still single-node is the kind of work that looks like progress. The
  interface is already Redis-shaped, so it stays a file when there is a number
  justifying it.
- **WebMCP / an agent-facing tool surface.** Shopify's own note is that agent
  support is still limited in some environments, and there is nothing here to
  test against. A speculative surface built now would be a guess shipped as an
  integration. Trigger: Shopify's agent support becoming generally available,
  at which point it is an additive namespace beside our own tools and nothing
  existing depends on it.



Two things here are unconditional because they pay for themselves immediately.
The rest is written, tested, and left switched off until a trigger fires —
that is what keeps this level from becoming a rewrite of a working system.

### Unconditional

- **Catalog freshness via webhooks + a background worker.** Subscribe
  `products/create`, `products/update`, `products/delete` and
  `collections/update`; re-embed only the affected products into the existing
  `VectorStore`; debounce a bulk import so a 400-product CSV upload is one
  rebuild and not 400. Today a merchant's price or title change can be up to
  six hours stale in semantic search. Needs no new scope — `read_products` is
  already granted.
- **Own analytics funnel.** An events table plus an admin view: opened →
  engaged → cards shown → card tapped → add to cart → checkout, split by
  holdout arm. This is the number that renews the subscription, and no
  competitor can show it.

### Gated (built, off by default)

| Piece | Trigger to switch on |
|---|---|
| Redis `SessionStore` | Conversations lost on deploy start mattering, or a second node |
| pgvector `VectorStore` + Postgres wiring | >25k vectors for one shop, or p95 search > 40 ms |
| Multi-node | Sustained load one node cannot serve — **and only after holdout assignment moves into the shared store**, which is the precondition the single-node SQLite constraint exists to protect |
| WebMCP / agent-facing tool surface | Shopify's agent support stops being environment-limited. Additive namespace beside our own tools; nothing existing depends on it |

### Gate

- Restart the gateway mid-conversation: the session survives and the shopper
  continues (Redis rung) — or, with Redis off, it degrades exactly as today.
- Change a product's title and price in the Shopify admin: it is findable by
  the new words, and priced correctly, within 60 seconds.
- Two nodes behind the proxy produce **one** consistent holdout assignment for
  the same session id — tested before multi-node is ever enabled, because the
  failure mode is silent and destroys the incrementality claim retroactively.

---

## 6. Sequencing and honesty about risk

- Levels 1 → 2 are the listening work you asked for, and Level 1 can cancel
  part of Level 2 on evidence. That is the point of it.
- Levels 3 → 4 are where the shopper feels the product get smarter and
  cheaper to run.
- Level 5 is infrastructure that should be *ready* long before it is needed.
- The biggest risk in this whole plan is not technical: **none of this has
  been verified against a live install with a real microphone and a real
  shopper.** Level 1's hand check is the first time that happens, and it is
  deliberately the first gate.
