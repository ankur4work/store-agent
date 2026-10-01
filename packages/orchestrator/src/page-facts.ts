/**
 * The three questions a shopper asks about the thing in front of them.
 *
 * ## Why this exists
 *
 * Measured, against the real store, on a product page:
 *
 * | question | to first audio | of which the model |
 * |---|---|---|
 * | "how much is it?" | 6488 ms | 3717 ms |
 * | "is this one in stock?" | 5781 ms | 4121 ms |
 * | "what sizes does this come in?" | 5863 ms | 3485 ms |
 *
 * The model is 62% of the wait, and it spends it re-deriving an answer we hold
 * exactly. Those three questions are a price, a boolean and a list, about a
 * product whose id the page already told us. A catalog read answers all three in
 * about 250 ms. Six seconds of silence is not a conversation; two is.
 *
 * ## The rule that makes it safe
 *
 * `intents.ts` may only ever narrow a set already on screen, because concluding
 * anything from an empty local filter risks telling a shopper the store does not
 * stock something it does. This file is allowed to make positive claims for the
 * opposite reason: it answers only about an id the page named, from a live
 * catalog read, which is the same evidence the model would have been given. The
 * sentence is assembled from that result and nothing else.
 *
 * Two guards keep it honest, and both fail towards the model:
 *
 * 1. **An allowlist, not a pattern.** Every word in the question must be a
 *    question word, a fact word, or a word from the product's own title. One
 *    unrecognised word — "how much is the *jacket*" — and the turn goes to the
 *    model, because an unrecognised word is the shopper talking about something
 *    other than what we are about to answer for.
 * 2. **`undefined` whenever the data will not carry the sentence.** No price on
 *    the variants, no option axes, an `available` nobody set: the model gets the
 *    turn. A fast lane that guesses is worse than no fast lane, because the
 *    shopper cannot tell it guessed.
 *
 * Colour-specific existence — "does this come in blue" — is deliberately NOT
 * here. Answering it well means judging whether "Navy" satisfies "blue", and
 * that is a judgement, not a lookup.
 */

export type PageFactKind = 'price' | 'stock' | 'options';

export interface PageFactRequest {
  readonly kind: PageFactKind;
  readonly reason: string;
  /** Which axis the shopper asked about, for an `options` question. */
  readonly axis?: 'size' | 'colour';
}

/** Just enough of the page for this decision. */
export interface FactPage {
  readonly type?: string;
  readonly productId?: string;
  readonly title?: string;
  readonly variantName?: string;
}

/**
 * A catalog variant, as stores actually send it.
 *
 * Structural rather than imported, and deliberately tolerant, because the live
 * store does not match the declared UCP type in three ways — each of which was a
 * silent wrong answer until it was read off the wire:
 *
 * - `options` is `[{name, label}]`, not `Record<string, string>`. Treating it as
 *   a record gave "The choice is 0: [object Object]", which the assistant said
 *   out loud.
 * - availability is nested: `availability.available`, not `available`. Read
 *   flatly it is `undefined`, so every stock question declined to the model.
 * - `price` carries the store's own formatted `display` string alongside the
 *   minor-unit amount.
 *
 * Both spellings of each are accepted. A reader that only understands the spec is
 * a reader that works on no real store.
 */
export interface FactVariant {
  readonly id?: string;
  readonly title?: string;
  readonly price?: {
    readonly amount?: number;
    readonly currency?: string;
    /** The store's own formatting. Preferred over ours when present. */
    readonly display?: string;
  };
  readonly available?: boolean;
  readonly availability?: { readonly available?: boolean };
  readonly options?:
    | Readonly<Record<string, string>>
    | readonly { readonly name?: string; readonly label?: string; readonly value?: string }[];
}

export interface FactProduct {
  readonly title?: string;
  readonly variants?: readonly FactVariant[];
}

/** A price formatter, injected so currency logic lives in exactly one place. */
export type FormatMoney = (amount: number, currency: string) => string;

const PRICE_RE = /\b(?:how much|price|prices|pricing|cost|costs|expensive)\b/i;
const STOCK_RE = /\b(?:in stock|stock|available|availability|sold out|out of stock|got any left|any left|left)\b/i;
const OPTIONS_RE = /\b(?:size|sizes|colour|colours|color|colors|option|options|variant|variants|choices?)\b/i;

const SIZE_RE = /\b(?:size|sizes)\b/i;
const COLOUR_RE = /\b(?:colou?rs?)\b/i;

/**
 * Words allowed to appear in a question this file will answer.
 *
 * Not a convenience — it IS the guard. The question must be made of nothing but
 * these and the product's own title, so anything that could be a second subject
 * sends the turn to the model.
 */
const ALLOWED = new Set([
  // asking
  'how', 'much', 'many', 'what', 'whats', 'which', 'is', 'are', 'does', 'do', 'did',
  'can', 'could', 'tell', 'me', 'about', 'please', 'so', 'and', 'or', 'for', 'of',
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'one', 'ones',
  'i', 'you', 'got', 'have', 'has', 'there', 'any', 'currently', 'right', 'now',
  'in', 'on', 'at', 'to', 'be', 'come', 'comes', 'coming', 'again', 'still',
  // the facts
  'price', 'prices', 'pricing', 'cost', 'costs', 'expensive', 'cheap',
  'stock', 'available', 'availability', 'sold', 'out', 'left', 'instock',
  'size', 'sizes', 'colour', 'colours', 'color', 'colors',
  'option', 'options', 'variant', 'variants', 'choice', 'choices',
]);

/**
 * Does the shopper mean the product on the page?
 *
 * A deictic ("how much is *this*") or a fragment with no subject at all ("how
 * much?", "in stock?") both mean the thing in front of them. Naming the product
 * counts too, which is why title words are allowed.
 */
const DEICTIC_RE = /\b(?:this|these|those|that|it|its|one|ones)\b/i;

function words(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Apostrophes are DELETED rather than split on, so "what's" is one word
      // and matches the allowlist. Splitting gives "what" + "s", and the stray
      // "s" then reads as an unrecognised word and sends the turn away. Both
      // the typewriter and the typographic form, because speech-to-text emits
      // the curly one.
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w !== '')
  );
}

/**
 * The words of the product's title that actually identify it.
 *
 * "The Complete Snowboard" contributes "complete" and "snowboard"; it must not
 * contribute "the", or every question containing the word "the" counts as having
 * named the product.
 */
function distinctiveTitleWords(title: string | undefined): Set<string> {
  return new Set(words(title ?? '').filter((w) => !ALLOWED.has(w)));
}

/**
 * Decide whether this is one of the three, and bail towards the model otherwise.
 */
export function classifyPageFact(message: string, page?: FactPage): PageFactRequest | undefined {
  if (page?.type !== 'product') return undefined;
  if (page.productId === undefined || page.productId === '') return undefined;

  const text = message.trim();
  if (text === '') return undefined;

  const ws = words(text);
  // Same ceiling as the filter lane: a sentence and a half is conversation.
  if (ws.length === 0 || ws.length > 9) return undefined;

  // Title words are part of the vocabulary — naming what you are looking at is
  // not a second subject.
  const titleWords = distinctiveTitleWords(page.title);
  for (const w of ws) {
    if (!ALLOWED.has(w) && !titleWords.has(w)) return undefined;
  }

  /**
   * Built entirely of permitted words and still not about this product — "how
   * much are the options and choices" has no subject at all. Checked here rather
   * than left to the caller, because a caller that forgets this guard gets a
   * plausible answer to a question nobody asked.
   */
  if (!refersToPage(text, page)) return undefined;

  const mentionsOptions = OPTIONS_RE.test(text);
  const mentionsPrice = PRICE_RE.test(text);
  const mentionsStock = STOCK_RE.test(text);

  /**
   * "How much are the different sizes" is two questions, and the interesting
   * answer is a table. The model writes a better one than a template can.
   */
  if (mentionsOptions && mentionsPrice) return undefined;

  if (mentionsOptions) {
    const axis = SIZE_RE.test(text) ? 'size' : COLOUR_RE.test(text) ? 'colour' : undefined;
    return {
      kind: 'options',
      reason: axis === undefined ? 'options on the page product' : `${axis}s on the page product`,
      ...(axis === undefined ? {} : { axis }),
    };
  }
  if (mentionsPrice) return { kind: 'price', reason: 'price of the page product' };
  if (mentionsStock) return { kind: 'stock', reason: 'stock of the page product' };
  return undefined;
}

/**
 * The shopper must be pointing at the page product, or naming it.
 *
 * Checked separately from the word allowlist because a question can be made
 * entirely of allowed words and still have no subject — "how many options"
 * is fine, "and the colours" on its own is not a question about this product.
 */
export function refersToPage(message: string, page?: FactPage): boolean {
  if (DEICTIC_RE.test(message)) return true;
  const titleWords = distinctiveTitleWords(page?.title);
  if (titleWords.size > 0 && words(message).some((w) => titleWords.has(w))) return true;
  // A bare fragment — "how much?", "in stock?" — has no subject because the page
  // is the subject.
  return words(message).length <= 4;
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

/** "a", "a and b", "a, b and c" — British, no Oxford comma. */
function list(items: readonly string[]): string {
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Shopify's placeholder for "this product has no options". */
function isPlaceholder(title: string | undefined): boolean {
  return title === undefined || title === '' || /^default title$/i.test(title);
}

/** `[{name, label}]` and `{name: label}` both reduce to this. */
function optionsOf(v: FactVariant): { name: string; value: string }[] {
  const raw = v.options;
  if (raw === undefined) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((o) => ({ name: o.name ?? '', value: o.label ?? o.value ?? '' }))
      .filter((o) => o.value !== '');
  }
  return Object.entries(raw as Record<string, string>)
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .map(([name, value]) => ({ name, value }));
}

/** `available` flat, or nested under `availability`; `undefined` means unknown. */
function availableOf(v: FactVariant): boolean | undefined {
  if (typeof v.available === 'boolean') return v.available;
  if (typeof v.availability?.available === 'boolean') return v.availability.available;
  return undefined;
}

/**
 * The price as a string, preferring the store's own.
 *
 * `display` is authoritative in a way our formatter cannot be: it is the figure
 * the merchant's own storefront shows, with their currency placement and
 * separators. We fall back to formatting minor units only when it is absent.
 */
function priceText(v: FactVariant, formatMoney: FormatMoney): string | undefined {
  const display = v.price?.display;
  if (typeof display === 'string' && display !== '') return display;
  const { amount, currency } = v.price ?? {};
  if (typeof amount !== 'number' || typeof currency !== 'string') return undefined;
  return formatMoney(amount, currency);
}

/** The variant the page says is selected, matched by name or by option value. */
function selectedVariant(
  product: FactProduct,
  variantName: string | undefined,
): FactVariant | undefined {
  const variants = product.variants ?? [];
  if (variantName === undefined || variantName === '') return undefined;
  const want = variantName.trim().toLowerCase();
  return variants.find(
    (v) =>
      v.title?.trim().toLowerCase() === want ||
      optionsOf(v).some((o) => o.value.trim().toLowerCase() === want),
  );
}

/** Option axes, keyed by their Shopify name ("Color", "Size"). */
function axesOf(product: FactProduct): Map<string, string[]> {
  const axes = new Map<string, string[]>();
  for (const v of product.variants ?? []) {
    for (const { name, value } of optionsOf(v)) {
      if (isPlaceholder(value)) continue;
      const seen = axes.get(name) ?? [];
      if (!seen.includes(value)) seen.push(value);
      axes.set(name, seen);
    }
  }
  /**
   * Themes and stores that send no `options` still send variant titles, which
   * are the option values joined. One unnamed axis is better than refusing to
   * answer at all — the shopper asked what the choices are, and these are them.
   */
  if (axes.size === 0) {
    const titles = (product.variants ?? [])
      .map((v) => v.title)
      .filter((t): t is string => !isPlaceholder(t));
    if (titles.length > 0) axes.set('', [...new Set(titles)]);
  }
  return axes;
}

/** Trim a long axis to something speakable. */
function speakable(values: readonly string[]): string {
  if (values.length <= 6) return list(values);
  return `${list(values.slice(0, 5))} and ${values.length - 5} more`;
}

export function answerPrice(
  product: FactProduct,
  variantName: string | undefined,
  formatMoney: FormatMoney,
): string | undefined {
  const variants = product.variants ?? [];

  const chosen = selectedVariant(product, variantName);
  if (chosen !== undefined) {
    const said = priceText(chosen, formatMoney);
    if (said !== undefined) return `It's ${said}.`;
  }

  /**
   * No selection, so speak the range rather than picking one — naming a single
   * price when the variants differ is the exact failure the grounding layer
   * exists to catch, and here there would be no model to catch it.
   *
   * Ranked on minor units, which is the only comparable form; the figures SPOKEN
   * are each variant's own text, so the store's formatting survives.
   */
  const priced = variants
    .map((v) => ({ v, amount: v.price?.amount, currency: v.price?.currency }))
    .filter(
      (p): p is { v: FactVariant; amount: number; currency: string } =>
        typeof p.amount === 'number' && typeof p.currency === 'string',
    );
  if (priced.length === 0) {
    // One variant and a display string but no minor units is still answerable.
    if (variants.length === 1) {
      const said = priceText(variants[0]!, formatMoney);
      if (said !== undefined) return `It's ${said}.`;
    }
    return undefined;
  }

  // A range across two currencies is a meaningless number, so stay in the first.
  const currency = priced[0]!.currency;
  const sameCurrency = priced.filter((p) => p.currency === currency);
  const low = sameCurrency.reduce((a, b) => (b.amount < a.amount ? b : a));
  const high = sameCurrency.reduce((a, b) => (b.amount > a.amount ? b : a));
  const lowText = priceText(low.v, formatMoney);
  const highText = priceText(high.v, formatMoney);
  if (lowText === undefined || highText === undefined) return undefined;
  if (low.amount === high.amount) return `It's ${lowText}.`;
  return `It ranges from ${lowText} to ${highText}.`;
}

export function answerStock(
  product: FactProduct,
  variantName: string | undefined,
): string | undefined {
  const variants = product.variants ?? [];
  const known = variants.filter((v) => availableOf(v) !== undefined);
  // Nobody set availability, so we do not know. Saying either thing would be
  // inventing stock information, which is the worst thing this file could do.
  if (known.length === 0) return undefined;

  const chosen = selectedVariant(product, variantName);
  const chosenAvailable = chosen === undefined ? undefined : availableOf(chosen);
  if (chosen !== undefined && chosenAvailable !== undefined) {
    const name = isPlaceholder(chosen.title) ? 'that one' : `the ${chosen.title}`;
    return chosenAvailable ? `Yes, ${name} is in stock.` : `${capitalise(name)} is sold out.`;
  }

  const inStock = known.filter((v) => availableOf(v) === true);
  if (inStock.length === 0) return 'It’s sold out at the moment.';
  if (inStock.length === known.length) return 'Yes, it’s in stock.';
  const names = inStock.map((v) => v.title).filter((t): t is string => !isPlaceholder(t));
  if (names.length === 0) return 'Yes, it’s in stock.';
  return `Yes — ${speakable(names)} ${names.length === 1 ? 'is' : 'are'} in stock.`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function answerOptions(
  product: FactProduct,
  axis: 'size' | 'colour' | undefined,
): string | undefined {
  const axes = axesOf(product);
  if (axes.size === 0) return undefined;

  const find = (re: RegExp): [string, string[]] | undefined => {
    for (const entry of axes) if (re.test(entry[0])) return entry;
    return undefined;
  };

  if (axis !== undefined) {
    const wanted = find(axis === 'size' ? SIZE_RE : COLOUR_RE);
    if (wanted !== undefined) return `It comes in ${speakable(wanted[1])}.`;

    /**
     * They asked for sizes and this product is sized one way — which is an
     * answer, not a failure, and the useful version of it says what you CAN
     * choose. This is the sentence the model took 3.5 s to produce.
     */
    const others = [...axes].filter(([name]) => name !== '');
    const noun = axis === 'size' ? 'one size' : 'one colour';
    if (others.length === 0) return `It only comes the one way.`;
    const described = others
      .map(([name, values]) => `${name.toLowerCase()}: ${speakable(values)}`)
      .join('; ');
    return `It comes in ${noun}. The choice is ${described}.`;
  }

  const described = [...axes].map(([name, values]) =>
    name === '' ? speakable(values) : `${name.toLowerCase()}: ${speakable(values)}`,
  );
  return `It comes in ${list(described)}.`;
}

/** Assemble the sentence for a classified request, or give the turn away. */
export function answerPageFact(
  request: PageFactRequest,
  product: FactProduct,
  variantName: string | undefined,
  formatMoney: FormatMoney,
): string | undefined {
  switch (request.kind) {
    case 'price':
      return answerPrice(product, variantName, formatMoney);
    case 'stock':
      return answerStock(product, variantName);
    case 'options':
      return answerOptions(product, request.axis);
  }
}
