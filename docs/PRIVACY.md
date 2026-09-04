# Privacy

What StoreAgent collects, where it goes, and how long it stays. Written to be
accurate rather than reassuring — if something here reads as uncomfortable,
that is a reason to change the system, not the wording.

---

## What is collected

| Data | Why | Retention |
|---|---|---|
| **Anonymous session id** | Ties a conversation together across page loads, and joins an order back to the session that produced it | 30 minutes idle; the id itself persists in the browser's `sessionStorage` for the tab session |
| **Conversation messages** | Needed to answer the question | Last 24 messages, in memory/database for 30 minutes idle, then discarded |
| **Page context** | Product/collection the shopper is viewing, so answers are relevant | Not stored beyond the turn |
| **Order id, total, cart token** | From the `orders/create` webhook — server-side truth for measuring whether the assistant caused a sale | Retained while the shop is installed |
| **Exposure record** | Which experiment arm a session was in, so incrementality can be measured | Retained while the shop is installed |
| **Merchant settings, plan, usage counts** | Running and billing the app | While installed |

## What is **not** collected

- **No shopper names, emails, addresses, or phone numbers.** Sessions are
  anonymous. If a shopper types contact details into the chat they are treated
  as message content and expire with the conversation.
- **No payment details, ever.** Checkout happens in Shopify.
- **No customer records from the store.** The app does not request
  `read_customers` and cannot read them.
- **No cross-site tracking.** The session id is scoped to one storefront's
  `sessionStorage` and is not a cookie, not shared between merchants, and not
  used for advertising.

## Where data goes

| Recipient | What | Why |
|---|---|---|
| **OpenAI** | The shopper's message, recent conversation, and catalog data retrieved for the answer | Generating the reply |
| **Shopify** | Catalog and cart requests | Answering accurately and building carts |
| **Nobody else** | — | There is no analytics vendor, no ad network, no data broker |

Conversation content is sent to OpenAI to produce an answer. It is not used to
train models under the API terms.

## What is never written to logs

Shopper conversation content is **structurally excluded** from logging, not
merely omitted by convention. Redaction happens in the logger by field name, so
a field called `message`, `reply`, `transcript`, `email` or `content` is
replaced before it is written — including from a call site that passes one by
mistake. Access tokens and API keys are redacted the same way.

Logs correlate on `sessionId`, which identifies a conversation without
revealing it. This makes some debugging harder, and that is the intended trade.

## Voice

Voice turns send audio to OpenAI for transcription and receive synthesised
speech back. Audio is not retained by StoreAgent — the transcript is treated
exactly like a typed message, and expires with the conversation.

## Merchant data rights

The mandatory Shopify webhooks are implemented and act, rather than
acknowledging and doing nothing:

- **`customers/redact`** — no shopper PII is stored, so there is nothing to
  erase. The endpoint responds and this remains true only while that is true;
  if lead capture ships, deletion goes here.
- **`customers/data_request`** — same: nothing to hand over.
- **`shop/redact`** — sent 48 hours after uninstall. Every record for the shop
  is deleted: installs, settings, sessions, exposures, carts, conversions,
  billing history.
- **`app/uninstalled`** — the access token is marked dead immediately.

Every webhook is HMAC-verified before it is acted on.

## Holdout experiment

A configurable share of sessions (default 20%) never see the assistant, so
there is an honest control group. Those sessions are still assigned an
anonymous id — that is what makes the control group countable — but no
conversation happens and no message data exists for them.

Merchants can set the share to 0 to switch measurement off entirely.

## Security

- Access tokens are encrypted in transit, never logged, never returned in an
  API response, and never included in an error message.
- OAuth uses a single-use, shop-bound state nonce; the callback is
  HMAC-verified.
- Admin requests are authenticated with Shopify session tokens, with the
  signing algorithm pinned.
- The metrics endpoint requires a bearer token and is disabled when none is
  configured.

## Contact

Questions about this policy, or a data request: **admin@stockping.site**
