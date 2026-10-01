import { createHash } from 'node:crypto';
import { GROUNDING_SYSTEM_RULES } from '@storeagent/grounding';

/**
 * Prompt assembly with cache discipline ENFORCED IN CODE.
 *
 * Prompt caching is not an optimization for us — it is the business model.
 * At 9M turns/month it is the difference between ~$84k and ~$310k of model
 * spend (ARCHITECTURE.md §7.4). A single interpolated timestamp in the system
 * prompt silently disables it, with no error and no failing test.
 *
 * So the audit checklist from ARCHITECTURE.md §7.3 lives here as executable
 * guards instead of review-time discipline.
 *
 * Render order is `tools → system → messages`. One cache breakpoint on the
 * last system block therefore caches tools + system together. Everything
 * volatile — cart state, current page, timestamps — belongs in the LAST USER
 * TURN, never here.
 */

export interface MerchantPack {
  readonly merchantId: string;
  /** Brand voice, tone, category taxonomy. Changes rarely — safe to cache. */
  readonly brandVoice: string;
  /** Condensed policy summary. Full corpus is retrieved per-turn via a tool. */
  readonly policySummary: string;
  /**
   * The merchant's own selling rules: what to push, what never to suggest.
   *
   * Per-MERCHANT, which is what makes it cacheable — a per-shopper rule here
   * would give every shopper their own prefix and destroy the cache hit rate
   * that §7.4 depends on. Anything that varies by shopper belongs in the turn
   * context instead.
   *
   * Free text written by a merchant, which means it can contain a date or an
   * order number, and `assertStable` rejects both. That is checked when they
   * save it (so they get a message they can act on) rather than discovered when
   * a shopper's turn throws.
   */
  readonly merchantRules?: string;
  /** Locale defaults for the storefront. */
  readonly locale: string;
  readonly currency: string;
}

export interface SystemBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: { readonly type: 'ephemeral'; readonly ttl?: '5m' | '1h' };
}

/** Patterns that would silently destroy the cached prefix if interpolated. */
const VOLATILE_PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: 'ISO timestamp', re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/ },
  { name: 'date', re: /\b\d{4}-\d{2}-\d{2}\b/ },
  { name: 'clock time', re: /\b\d{1,2}:\d{2}(?::\d{2})?\b/ },
  { name: 'UUID', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: 'session id', re: /\bsess(?:ion)?[_-][A-Za-z0-9]{6,}/ },
  { name: 'cart id', re: /gid:\/\/shopify\/Cart\//i },
  { name: 'epoch millis', re: /\b1[6-9]\d{11}\b/ },
];

export class UnstablePrefixError extends Error {
  override readonly name = 'UnstablePrefixError';
  constructor(readonly reason: string, readonly evidence: string) {
    super(
      `Cached prompt prefix contains volatile content (${reason}: "${evidence}"). ` +
        `This silently disables prompt caching — move it into the last user turn instead. ` +
        `See ARCHITECTURE.md §7.3.`,
    );
  }
}

/**
 * Throw if the text would break caching. Called on every prefix build, in
 * production as well as tests — the failure mode is silent and expensive
 * enough to be worth the microseconds.
 */
export function assertStable(text: string): void {
  for (const { name, re } of VOLATILE_PATTERNS) {
    const m = re.exec(text);
    if (m) throw new UnstablePrefixError(name, m[0]);
  }
}

const BASE_BEHAVIOUR = `You are a shopping assistant embedded in an online store.

Answer in short, plain sentences. Lead with the answer. No preamble, no
"Great question!", no emoji unless the brand voice below enables them. Shoppers
read in glances on phones — every wasted clause costs attention.

## Be brief. This is a chat bubble, not a product page.

- **A direct question gets one or two sentences.** Nothing more.
- **A list gets one line per product**: name, price, and at MOST one detail
  that separates it from the others. Not a description, not a feature list.
- **Never describe what the cards already show.** The shopper is looking at
  the picture, the title and the price while you speak.
- **End with one short question**, not a menu of options.

Every answer is also read aloud. Anything past about forty words stops being
an answer and becomes a monologue someone has to sit through, and a shopper
cannot skim speech.

Right: a count, then one line per product — its name and its price from the
tool result, nothing else — then one short question.

Wrong: the same products with a sentence of copy each, their colourways,
their size ranges, and a closing paragraph offering to narrow it down.

No example is given here on purpose. An earlier version of this section
showed a worked one with prices in it, and those prices were copied into
real answers instead of being read from the tool result — so the tripwire
retracted the reply, twice, and the turn went to a human. Every number you
write comes from a tool result in THIS conversation. There are no numbers
anywhere in these instructions to reuse.

Never ask for something you can already see. You are given the current page,
the cart, and the shopper's locale. Asking "which product?" while they are
looking at it is the fastest way to feel useless.

Every reply ends with a way forward.

If you cannot answer — a tool failed, the data is missing, or the question is
outside what you can verify — say so plainly and give a concrete route: offer to
put the shopper in touch with the team, or take an email so someone can follow
up. Call the escalate_to_human tool when you do this; it is how the handoff
actually reaches anyone.

"Try again later", "please check back", and "contact us" with no route are NOT
ways forward. They hand the problem back to the shopper and end the
conversation. An honest refusal that captures an email is a success; a refusal
that leaves someone with nothing is a lost sale.

**Being asked to recommend is not a verification problem.** "Which is best?",
"what do you suggest?", "I want the best one" — these ask for a shop
assistant's opinion, and an opinion is yours to give. There is no fact to check
and nothing to escalate. Pick one of the products you found, name it, and say
what makes it the pick using that product's own attributes: the material, the
cushioning, the price, what is actually in stock in their size.

"I can't verify which shoe is best" is not honesty, it is a shop assistant
refusing to do the one thing shoppers ask them for. Escalate when you cannot
establish a FACT — a price, stock, a policy, whether something exists. Never
escalate a matter of taste.

You may say a product is lighter, cheaper, warmer or better reviewed only if
the catalog says so. You may always say "I'd go with this one" and explain why.

## Sell like someone who works here

A good shop assistant does not answer queries. They work out what the person
is actually after and put something in their hands.

**Search the way they described it, not the way they typed it.** "Something
warm for a wedding", "open-toe shoes", "a black bag with a gold chain" are
descriptions of a product, not keywords. Search for the noun, then read the
results properly — colour, material, style and occasion live in the title,
the description, the tags and the variant options, not only in the words the
shopper happened to use. Search again with different wording if the first
attempt comes back thin.

**Never end on "we don't have that".** That is the one reply a shop assistant
never gives. If the exact thing is not there, say so in a clause, not a
paragraph, and spend the rest of the sentence on the nearest real thing:

  Wrong: "Sorry, we don't have any long dresses."
  Right: "No long dresses in at the moment — the midi in black is the closest
          cut we have, and it's £68. Want to see it?"

**Answer what they meant.** "A bag that goes with a black dress" is a request
for a recommendation, not a search for the word "black". Pick something that
genuinely works, and say in a few words WHY it works — that is the part a
shopper cannot get from a product grid.

**One good question beats five options.** If size, occasion or budget would
change what you recommend, ask for the one that matters most and nothing
else. Never interrogate.

**Speak the shopper's language.** Reply in whatever language they wrote or
spoke in, matching it exactly — including the script. Product names, and
prices as given, stay verbatim; never translate a product title.`;

/**
 * Build the cacheable prefix. Deterministic: identical inputs produce
 * byte-identical output, forever.
 */
export function buildCachedPrefix(pack: MerchantPack, ttl: '5m' | '1h' = '5m'): SystemBlock[] {
  /**
   * Section order is FIXED, and the merchant's rules sit at a fixed position.
   *
   * Render order decides the cached prefix, so reordering these — or including a
   * section conditionally in the middle — invalidates every merchant's cache at
   * once. An absent rules block simply is not there, which is stable for that
   * merchant because it is absent on every one of their turns.
   *
   * The rules come AFTER the grounding rules deliberately. A merchant writing
   * "always say the winter coat is in stock" must not be able to talk the model
   * out of checking, and the later text is the more specific instruction — so
   * the rules are framed as preferences, and the sentence below says outright
   * that they lose to the facts.
   */
  const rules =
    pack.merchantRules === undefined || pack.merchantRules.trim() === ''
      ? undefined
      : `## Merchant's selling rules\n` +
        `These are this shop's own preferences. Follow them, EXCEPT where they ` +
        `conflict with a tool result or with the rules above — a price, a stock ` +
        `level and a policy come from the catalog, never from here.\n\n` +
        pack.merchantRules.trim();

  const text = [
    BASE_BEHAVIOUR,
    GROUNDING_SYSTEM_RULES,
    `## Brand voice\n${pack.brandVoice}`,
    `## Policy summary\n${pack.policySummary}`,
    ...(rules === undefined ? [] : [rules]),
    `## Storefront defaults\nLocale: ${pack.locale}. Currency: ${pack.currency}.`,
  ].join('\n\n');

  assertStable(text);

  // Single breakpoint on the last (only) system block → caches tools + system.
  return [{ type: 'text', text, cache_control: { type: 'ephemeral', ttl } }];
}

/**
 * Stable fingerprint of the cached prefix.
 *
 * Store this per merchant. If it changes between turns of a live session,
 * the cache was just invalidated and every subsequent turn pays full input
 * price — alert on it rather than discovering it in the monthly bill.
 */
export function prefixFingerprint(blocks: readonly SystemBlock[]): string {
  return createHash('sha256').update(blocks.map((b) => b.text).join(' ')).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Volatile turn context — everything that must NOT go in the prefix
// ---------------------------------------------------------------------------

export interface TurnContext {
  readonly sessionId: string;
  /** Where the shopper is right now. */
  /**
   * What the shopper is looking at, read from Shopify's own page metadata.
   *
   * Identity only — no price and no stock. This arrives from the shopper's
   * browser, so treating it as fact would let a modified page put a figure in the
   * assistant's mouth. The ids are what matter: with them the catalog can be
   * asked authoritatively, which is where every number comes from.
   */
  readonly page?: {
    readonly type: 'product' | 'collection' | 'cart' | 'other';
    /** The product or collection's own name, NOT the browser tab caption. */
    readonly title?: string;
    readonly productId?: string;
    /** The variant the shopper has actually selected, from `?variant=`. */
    readonly variantId?: string;
    /** How that variant reads, e.g. "Large / Blue". */
    readonly variantName?: string;
    /** URL handle, which survives translation and markets prefixes. */
    readonly handle?: string;
    readonly collectionId?: string;
  };
  /** Current cart summary, so the agent never has to ask. */
  readonly cart?: { readonly itemCount: number; readonly subtotalMinor?: number };
  /** True when the shopper just navigated — lets the agent acknowledge it. */
  readonly justNavigated?: boolean;
  /**
   * What the shopper has already told us, rendered.
   *
   * Belongs HERE, in the volatile block, and not in the cached prefix: it is
   * per-shopper, and a per-shopper prefix gives every visitor their own cache
   * entry, which is the difference between a 90% input-cost saving and none.
   */
  readonly preferences?: string;
}

/**
 * Render volatile state as a block appended to the LAST USER TURN.
 * This is the correct home for anything that changes per request.
 */
export function renderTurnContext(ctx: TurnContext): string {
  const parts: string[] = [];
  if (ctx.page) {
    /**
     * Say precisely what is on screen, and say what "this" refers to.
     *
     * The previous version of this line could only manage "Shopper is viewing
     * the product X", where X was a browser tab caption. A shopper asking "does
     * this come in my size" was therefore answered from a guess at the product's
     * name — while Shopify had published the id, the variant list and the
     * selected variant on the page the whole time.
     *
     * Naming the deictic explicitly matters more than it looks: without it the
     * model has to infer that "this", "it" and "these" mean the product in the
     * context block, and it does not reliably do so when the shopper's sentence
     * mentions anything else.
     */
    const p = ctx.page;
    if (p.type === 'product' && (p.title !== undefined || p.productId !== undefined)) {
      const named = p.title === undefined ? 'a product' : `"${p.title}"`;
      const selected = p.variantName === undefined ? '' : `, with ${p.variantName} selected`;
      parts.push(
        `Shopper is on the product page for ${named}${selected}. ` +
          `"this", "it" and "these" mean THAT product unless they say otherwise.`,
      );
      // The id is for tools, not for the shopper, and is never spoken.
      if (p.productId !== undefined) {
        parts.push(
          `Its product id is ${p.productId}${
            p.variantId === undefined ? '' : ` and the selected variant id is ${p.variantId}`
          } — use get_product with that id rather than searching by name, and never read an id aloud.`,
        );
      }
    } else if (p.type === 'collection') {
      parts.push(
        `Shopper is browsing the ${p.title === undefined ? 'a' : `"${p.title}"`} collection. ` +
          `"these" means things in it.`,
      );
    } else if (p.type === 'cart') {
      parts.push('Shopper is looking at their cart.');
    } else if (p.title !== undefined) {
      parts.push(`Shopper is on the page "${p.title}".`);
    }
  }
  if (ctx.cart) {
    parts.push(
      ctx.cart.itemCount === 0
        ? 'Cart is empty.'
        : `Cart has ${ctx.cart.itemCount} item(s)${
            ctx.cart.subtotalMinor !== undefined ? `, subtotal $${(ctx.cart.subtotalMinor / 100).toFixed(2)}` : ''
          }.`,
    );
  }
  if (ctx.justNavigated === true) {
    parts.push('The shopper just navigated here from your previous suggestion — acknowledge it naturally.');
  }
  /**
   * Last, so it is the nearest instruction to the shopper's own message.
   *
   * The rule it enforces — never ask for something already given — was in the
   * system prompt and unkeepable: history is capped and a size mentioned eight
   * turns ago competes with everything else in the window. Being asked your size
   * twice is the moment someone decides the thing is not listening.
   */
  if (ctx.preferences !== undefined && ctx.preferences !== '') parts.push(ctx.preferences);
  return parts.length === 0 ? '' : `<context>\n${parts.join('\n')}\n</context>`;
}
