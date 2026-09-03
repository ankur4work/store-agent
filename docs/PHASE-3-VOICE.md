# Phase 3 — Voice

**Status: built and verified against the live API.** 565 tests, typecheck clean,
`scripts/check-voice.mjs` green.

```bash
node scripts/check-voice.mjs   # TTS, STT round trip, grounded utterances
```

---

## The decision that shaped everything: pipeline, not speech-to-speech

`GET /v1/models` confirms a full realtime speech-to-speech stack is available —
`gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-live-transcribe`. Earlier notes
in this repo suggested it "could collapse the STT → LLM → TTS pipeline into one
hop", and it could.

**It would collapse the grounding with it.** That suggestion was wrong, and this
is the correction:

| | Speech-to-speech | Pipeline (chosen) |
|---|---|---|
| Output | Audio | Text, then audio |
| Structured `{reply, claims}` | ✗ none | ✓ unchanged |
| Grounding validator | ✗ nothing to check | ✓ unchanged |
| Mid-stream tripwire | ✗ no text stream | ✓ unchanged |
| Retracting a bad claim | **✗ impossible** | ✓ never spoken |
| Latency | Lower | Higher |

The last row is the one that settles it. In chat, a tripwire trip clears the
bubble and the shopper never sees the number. **Audio cannot be un-said.** A
hallucinated price spoken aloud is in the shopper's ear permanently, and the
product's entire claim is that this does not happen.

So voice reuses the text stack completely unchanged. We trade a few hundred
milliseconds for the guarantee the product is sold on.

## How grounding reaches the speaker

The composition turned out to be clean, because the orchestrator already emits
exactly the right thing:

```
mic → STT → the SAME grounded orchestrator → tripwire-settled text
    → SpeechChunker → whole utterances → TTS → speaker
```

The tripwire already releases only text that has settled and passed validation.
That output is precisely what is safe to speak — so `SpeechChunker` sits on the
existing stream and nothing about the grounding path changed.

**The chunker runs server-side**, not in the widget. The widget is deliberately
buildless, so importing the package there would have meant duplicating tested
logic into untested inline JS. Instead the gateway emits `speak` events carrying
complete utterances, and the widget only has to queue and play them.

---

## `packages/voice`

Three pure, heavily-tested pieces. The audio plumbing is in the widget; the
decisions are here where they can be tested.

### SpeechChunker — the seam between grounding and audio

Turns a trickle of validated deltas into utterances TTS can voice naturally.
Two failure modes it exists to prevent:

- **Speaking fragments** — sending every delta to TTS produces disjointed audio
  with no sentence prosody.
- **Never speaking** — waiting strictly for a full stop means a long clause with
  no terminal punctuation stalls the audio indefinitely, so there is a
  soft-boundary escape hatch at a comma or clause break.

The subtle cases, all tested: it must **not** split `$189.` into a sentence
because `00` is still arriving; must not split `4.6`, `approx. 3 days`,
`5 p.m.`, or `Dr. Chen`; must keep a closing quote with its sentence; and must
not emit a lone `Ok.` that gets a full stop's worth of pause.

Live output from the verification run:

```
· Yes.
· The Merino Wool Overcoat is a full-length, water-resistant merino coat for $189.00.
· It is available in S and M; L is currently unavailable.
· Choose S or M if you'd like to add it to your cart.
```

Whole clauses, price intact.

### Endpointing — where the dead air comes from

A fixed silence timeout forces a choice between two bad outcomes: long enough
not to interrupt people costs 500–800ms on every turn; short enough to feel
responsive cuts off anyone who pauses mid-sentence.

The way out is to stop treating all silence as equal. 400ms after *"how much is
the wool coat?"* means done. The same 400ms after *"I'm looking for something
warm and"* means mid-thought.

| Signal | Threshold |
|---|---:|
| Terminal punctuation, or a complete question | **260ms** |
| No strong signal | 550ms |
| Ends on a conjunction, article, preposition or filler | **1100ms** |
| STT emits a final transcript | immediate |

Plus `shouldSpeculate()` — begin generating on the interim transcript rather
than waiting for the endpoint, and `speculationStillValid()` to decide whether
the finalised transcript diverged enough to discard that work. It is tolerant on
purpose: STT routinely tidies punctuation between interim and final, and
restarting over `coat` → `coat.` would throw away the entire benefit.

### VoiceSession — states and barge-in

`idle → listening → thinking → speaking`. The state is also what the UI renders;
a shopper who cannot tell whether they were heard will repeat themselves, and
then you are both talking.

Barge-in cancels **both** the audio and the in-flight generation. Cancelling only
audio leaves the model producing a reply to a question the shopper has already
abandoned, which then arrives late and answers the wrong thing.

One subtlety worth naming: **the agent's own audio leaks into the microphone.**
A detector that trusts raw energy interrupts itself on its own first syllable.
So barge-in requires speech sustained past a guard window, with echo-cancelled
input.

---

## Verified live

```
ok  speak returns audio                       42699 bytes in 2660ms
ok  rejects empty / over-long text            400 / 413
ok  transcribe returns 200
    heard: "The merino wool overcoat is $189."
ok  round trip recovered the price
ok  round trip recovered the product
ok  turn was grounded
ok  every utterance is a whole clause
ok  no utterance splits a price mid-number
```

The round trip is the meaningful one: our own TTS output fed straight back into
STT recovers both the product and the price.

**Defect found by that round trip:** the upload's filename extension must match
the actual container, not just the declared MIME type. Our TTS returns ogg/opus,
which was being uploaded as `turn.webm` and rejected upstream as an opaque 502.
There is now a proper container mapping.

---

## Open

- **No real microphone has been used.** The widget's capture, VAD, and playback
  paths are written but unverified — I cannot open a browser here. Everything
  behind them (chunking, endpointing, barge-in logic, STT, TTS, grounding) is
  tested or verified live; the audio plumbing is not.
- **Browser VAD is energy-based only.** The tested transcript-aware endpointer
  runs server-side; the widget has just loudness, so its thresholds are
  deliberately conservative. Wiring the two together is the next latency win.
- **TTS latency is ~2.6s for a sentence.** Acceptable because playback starts on
  the *first* utterance while later ones synthesize, but it makes the first word
  slower than the §6.3 target. Streaming TTS would fix it.
- **Cost is unmodelled.** Voice adds STT + TTS per turn on top of the model.
  §7.4 covers neither, and voice turns are likely several times a text turn.
- **Barge-in is untested against real echo.** The guard window is a reasoned
  default, not a measured one.
