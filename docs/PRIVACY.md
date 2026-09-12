# Privacy Policy — StoreAgent

**Effective date:** [DATE]
**Last updated:** [DATE]

StoreAgent ("the app", "we", "us") is a shopping assistant that Shopify
merchants install on their store. It answers shoppers' questions about the
merchant's products using the merchant's own catalog and policies.

This policy explains what the app processes, why, who it is shared with, and
how long it is kept. It covers two groups of people: the **merchant** who
installs the app, and the **shopper** who talks to it on the merchant's
storefront.

Provided by [LEGAL ENTITY NAME], [REGISTERED ADDRESS].
Contact: [PRIVACY EMAIL].

---

## 1. Roles

For shopper data, the **merchant is the data controller** and we act as a
**processor** on their instructions. The merchant is responsible for their own
storefront privacy notice and for the lawful basis on which shoppers use the
assistant.

For merchant account data (your shop domain, settings, billing status), we are
the controller.

---

## 2. What the app processes

### From shoppers

| Data | Why | Kept |
|---|---|---|
| Messages typed into the assistant | To answer the question | In-session only, 30 minutes |
| Voice recordings | Transcribed to text, then discarded | Not stored |
| Conversation history | So a follow-up question makes sense | Last 30 messages, 30 minutes |
| A random session identifier | To keep one conversation together | 30 minutes |
| Truncated IP address | Abuse and rate limiting only | Not stored beyond the counter |
| Experiment group (shown / held back) | To measure whether the assistant adds sales | Until the merchant uninstalls |
| Cart and order identifiers | To attribute a sale to a conversation | Until the merchant uninstalls |

**Voice recordings are never stored.** Audio is passed through to the
transcription service, converted to text, and discarded. We keep no audio
files.

**Conversation content is never written to our logs.** Redaction happens on the
way out, keyed on field name, so an accidentally-logged message produces
`[redacted]` rather than the text.

**IP addresses are truncated** (IPv6 to a /64 prefix) and used only as a rate
limiting counter. They are not stored against a conversation or a person.

### From merchants

- Shop domain, and the access token Shopify issues at install
- App settings (accent colour, corner radius, position, greeting, measurement
  split)
- Plan, usage counts and billing status
- Product catalog data — titles, descriptions, prices, options, tags,
  availability and **product images** (see §4)

---

## 3. What the app does NOT collect

- **No customer accounts, names, addresses, emails or phone numbers.** The app
  does not read Shopify customer records and has no `read_customers` access.
- **No payment details.** Card data is never seen by the app; all charges run
  through Shopify Billing.
- **No cross-site tracking.** Nothing is shared with advertising networks, and
  no advertising or analytics cookies are set.
- **No shopper profiles.** Session identifiers are random, expire in 30
  minutes, and are not linked to an identity or to other sites.

Because of this, Shopify's `customers/redact` and `customers/data_request`
webhooks return "no stored personal data" — there is none to return or erase.

---

## 4. Automated processing and AI

The app sends the following to OpenAI to generate an answer:

- The shopper's message and the recent conversation
- Voice audio, for transcription, and answer text, for speech
- The merchant's product data **including product images**, which are read once
  and converted into a text description of what is visible (colour, material,
  pattern, style) so shoppers can search by describing a product
- Mathematical representations ("embeddings") of product text, stored by us to
  make search work

Answers are generated automatically. The assistant is constrained to the
merchant's catalog and policies, and any statement it cannot trace to that
source is withheld and offered to a human instead.

**No automated decision-making with legal or similarly significant effects is
performed.** The assistant answers questions and recommends products; it does
not decide anything about a person.

---

## 5. Who we share data with

| Recipient | Purpose | Location |
|---|---|---|
| OpenAI | Generating answers, transcription, speech, embeddings, reading product images | United States |
| Shopify | Catalog, cart and billing, under the merchant's own agreement | Per Shopify |
| [HOSTING PROVIDER] | Running the service | [REGION] |

OpenAI does not use data submitted through its API to train its models.

**Live voice captions use the browser's own speech recognition.** When a
shopper uses voice in a supported browser, the words appearing on screen as
they speak are produced by that browser's built-in service — in Google Chrome,
this sends audio to Google under Google's privacy policy, not ours. It is used
only for the on-screen caption; the transcript the assistant actually acts on
comes from our own processing described above. Browsers without this feature
simply show no live caption.

We do not sell personal data, and we do not share it for cross-context
behavioural advertising.

---

## 6. Where data is stored

Service data is stored on servers in [REGION]. Processing by the recipients in
§5 may take place in the United States. Transfers out of the UK/EEA rely on the
European Commission's Standard Contractual Clauses together with the UK
International Data Transfer Addendum where applicable.

---

## 7. Retention

- **Conversations and sessions:** 30 minutes from the last message, then
  deleted automatically.
- **Measurement data** (experiment group, cart and order identifiers, revenue
  totals): kept while the app is installed, because removing it would destroy
  the merchant's own measurement of whether the assistant works.
- **Product index and image descriptions:** rebuilt periodically; deleted when
  the merchant uninstalls.
- **Merchant account, settings and billing records:** kept while installed, and
  after uninstall only as long as required for tax and accounting.

On uninstall, Shopify sends a `shop/redact` request and all data for that shop
— settings, measurement data, billing history and the product index — is
deleted.

---

## 8. Legal bases (UK GDPR / EU GDPR)

- **Contract** — providing the app to the merchant.
- **Legitimate interests** — answering a shopper's question, keeping the
  service secure and available, and measuring whether the assistant adds sales.
  Interests balanced against shoppers' rights; the data is minimal, short-lived
  and not linked to an identity.
- **Legal obligation** — tax and accounting records.

---

## 9. Your rights

Anyone whose data we process may request access, correction, erasure,
restriction, portability, or object to processing.

**Shoppers** should contact the merchant whose store they used, as that
merchant is the controller. We will assist them in responding.

**Merchants** may contact us directly at [PRIVACY EMAIL]. We respond within 30
days.

You may also complain to your data protection authority — in the UK, the
Information Commissioner's Office (ico.org.uk).

---

## 10. Security

- All traffic is encrypted in transit (TLS).
- Access tokens are never logged and are never returned in any API response.
- Offline access tokens expire after one hour and are rotated automatically, so
  a stored token is short-lived by design.
- Tokens and settings are held in a database on a server with restricted
  access. [CONFIRM BEFORE PUBLISHING: add "on an encrypted volume" only if disk
  encryption is actually enabled on the host.]
- Conversation content is excluded from logging by default rather than by
  discipline — redaction is enforced in the logger itself.
- Access to production systems is limited to personnel who need it.

No system is perfectly secure, and we do not claim otherwise. If a breach
affects your data we will notify you and the relevant authority as required.

---

## 11. Children

The app is not directed at children and we do not knowingly process data from
anyone under 16. Contact us if you believe we have.

---

## 12. Cookies and storage

The app sets **no cookies**. It uses your browser's `sessionStorage` to keep
the conversation open as you move between pages of the store, and a single
local value to keep the measurement group consistent. Both are cleared when the
browser session ends or the store is left.

---

## 13. Changes

Material changes will be posted here with an updated date, and merchants will
be notified in the app or by email before the change takes effect.

---

## 14. Contact

[LEGAL ENTITY NAME]
[REGISTERED ADDRESS]
[PRIVACY EMAIL]

[UK/EU REPRESENTATIVE, if you have no UK/EU establishment]
