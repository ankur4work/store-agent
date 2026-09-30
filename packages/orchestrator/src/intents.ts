/**
 * The deterministic lane: turns that need no model at all.
 *
 * ## Why
 *
 * Every turn currently costs a model round trip, and a good number of them are
 * not questions. "Show me the cheaper ones" is a filter over what is already on
 * screen. "What's in my cart" is a read. Routing those through an LLM buys
 * nothing and costs the shopper two to five seconds and the merchant a turn of
 * allowance — and it is *less* reliable, because the model has to be trusted to
 * re-derive an answer we already hold exactly.
 *
 * So: deterministic where the answer is determined, the model where it is not.
 *
 * ## The rule that makes this safe
 *
 * **A local filter may only ever narrow a set the shopper is already looking
 * at.** It cannot search, and it must never answer "nothing matches".
 *
 * That rule is the whole design. "Do you have it in blue" looks like a filter
 * and is not: the blue one may exist and simply not be in the six results on
 * screen, so answering from the visible set would mean telling a shopper the
 * store does not stock something it does. Narrowing a visible set is always
 * true — those products are right there. Concluding anything from an empty
 * result is not, so an empty filter hands the turn to the model instead.
 *
 * Everything here is conservative in the same direction. The classifier's
 * default answer is "not mine": a phrase that is nearly a filter goes to the
 * model, which is slower and right, rather than fast and wrong. A router that
 * swallows one ambiguous turn is worse than no router, because the failure is
 * silent — the shopper just gets a confidently wrong answer with no sign that
 * anything was skipped.
 */

export interface ProductFilter {
  /** A colour word the shopper named, lowercased. */
  readonly colour?: string;
  /** Upper bound in minor units, from "under fifty" or "under $50". */
  readonly maxMinor?: number;
  /** Lower bound, from "over fifty". */
  readonly minMinor?: number;
  /** "the cheaper ones" — relative, so it ranks rather than filters. */
  readonly cheaper?: boolean;
  /** "the dearer ones". */
  readonly dearer?: boolean;
}

export type FastIntent =
  /** Read the cart and say what is in it. */
  | { readonly kind: 'cart'; readonly reason: string }
  /** Narrow the products already on screen. */
  | { readonly kind: 'filter'; readonly filter: ProductFilter; readonly reason: string }
  /** Not ours. Goes to the model. */
  | { readonly kind: 'none'; readonly reason: string };

export interface IntentContext {
  /** Products the shopper is currently looking at, from the previous turn. */
  readonly visibleProducts: number;
  /** A cart exists for this session. */
  readonly hasCart: boolean;
}

/**
 * Colour words worth recognising.
 *
 * Deliberately basic terms only. "Sage", "oatmeal" and "gunmetal" are real
 * product colours and are also words that appear in descriptions and titles for
 * other reasons, so matching them locally would narrow a set on a coincidence.
 * A shopper using one of those gets the model, which can read the variant
 * options properly.
 */
const COLOURS: readonly string[] = [
  'black',
  'white',
  'grey',
  'gray',
  'red',
  'blue',
  'green',
  'yellow',
  'orange',
  'purple',
  'pink',
  'brown',
  'beige',
  'navy',
  'cream',
  'silver',
  'gold',
];

/**
 * Number words, because a voice transcript spells them.
 *
 * "under fifty dollars" is how someone says it out loud, and the transcript
 * carries exactly that. Stopping at a hundred is deliberate: past that, spoken
 * amounts get compound ("two hundred and fifty") and a half-built parser would
 * read that as two, which is a price filter that silently hides the catalogue.
 */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
  ten: 10,
  fifteen: 15,
  twenty: 20,
  twentyfive: 25,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
};

/** A money amount in the message, in MINOR units, or undefined. */
export function parseAmountMinor(text: string): number | undefined {
  // Digits first: "$50", "50", "49.99".
  const digits = /(?:[$£€]\s*)?(\d+(?:\.\d{1,2})?)/.exec(text);
  if (digits) {
    const value = Number(digits[1]);
    if (Number.isFinite(value)) return Math.round(value * 100);
  }
  // Then spelled, with "twenty five" joined so the table can hold it.
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const joined = words.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+five\b/g, (_m, tens: string) =>
    tens === 'twenty' ? 'twentyfive' : `${tens}five`,
  );
  for (const token of joined.split(' ')) {
    const n = NUMBER_WORDS[token];
    if (n !== undefined) return n * 100;
    // "fiftyfive" style joins we did not table: fall back to the tens.
    const tens = /^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)five$/.exec(token);
    if (tens) return (NUMBER_WORDS[tens[1]!]! + 5) * 100;
  }
  return undefined;
}

/**
 * Is this a cart read?
 *
 * Requires a determiner — "my cart", "the cart", "open cart". A bare "cart" is
 * NOT enough, because a shop can sell carts: "do you have a cart" is a catalogue
 * question in a garden centre and a cart read nowhere.
 */
const CART_RE =
  /\b(?:open|show|view|see|check|what(?:'s| is| are)?(?: in)?)\s+(?:my |the )?(?:cart|basket|bag)\b|\b(?:my|the)\s+(?:cart|basket)\b/i;

/** Phrases that mention a cart but are not a request to read it. */
const NOT_CART_RE =
  /\b(?:add|remove|delete|empty|clear|cancel|checkout|check out|pay|buy|order)\b|\?\s*$|\bhow do i\b|\bcan i\b/i;

/**
 * Narrowing phrases. Each requires the shopper to be pointing at what is on
 * screen — "the blue ones", "just the cheap ones" — not asking whether a thing
 * exists.
 */
const NARROWING_RE =
  /\b(?:just|only|show|show me|filter|narrow|what about)\b|\bones?\b|\bthose\b|\bthese\b|^(?:cheaper|dearer|pricier|less)\b/i;

/** A question about existence or detail. Never a local filter. */
const EXISTENCE_RE =
  /\b(?:do|does|did|have you|is there|are there|can i get|do you (?:have|sell|stock|carry))\b/i;

export function classifyIntent(message: string, ctx: IntentContext): FastIntent {
  const text = message.trim();
  if (text === '') return { kind: 'none', reason: 'empty' };
  // Long messages are conversation, not commands. A shopper writing a sentence
  // and a half wants to be understood, not pattern-matched.
  if (text.split(/\s+/).length > 9) return { kind: 'none', reason: 'too long to be a command' };

  if (CART_RE.test(text) && !NOT_CART_RE.test(text)) {
    // A cart read with no cart is still a cart read — "nothing yet" is the
    // correct, deterministic answer and does not need a model either.
    return { kind: 'cart', reason: 'cart read' };
  }

  /**
   * Existence questions are handed over even when they look like filters.
   *
   * "do you have these in blue" would filter to the blue products already on
   * screen, and if the blue one is simply not among the six we showed, the
   * shopper is told it does not exist. The model can search properly.
   */
  if (EXISTENCE_RE.test(text)) return { kind: 'none', reason: 'existence question, needs a search' };

  // Nothing to narrow. Sending this to the model is what makes "show me the
  // blue ones" work as a fresh search when there is no visible set.
  if (ctx.visibleProducts === 0) return { kind: 'none', reason: 'no visible products to narrow' };

  if (!NARROWING_RE.test(text)) return { kind: 'none', reason: 'not a narrowing phrase' };

  const lower = text.toLowerCase();
  const filter: {
    colour?: string;
    maxMinor?: number;
    minMinor?: number;
    cheaper?: boolean;
    dearer?: boolean;
  } = {};

  const colour = COLOURS.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(lower));
  if (colour !== undefined) filter.colour = colour === 'gray' ? 'grey' : colour;

  if (/\b(?:under|below|less than|cheaper than|up to|max)\b/.test(lower)) {
    const amount = parseAmountMinor(lower);
    if (amount !== undefined) filter.maxMinor = amount;
  }
  if (/\b(?:over|above|more than|at least|from)\b/.test(lower)) {
    const amount = parseAmountMinor(lower);
    if (amount !== undefined) filter.minMinor = amount;
  }
  // Relative, with no number: rank rather than filter.
  if (/\b(?:cheap|cheaper|cheapest|budget|affordable|less expensive)\b/.test(lower) && filter.maxMinor === undefined) {
    filter.cheaper = true;
  }
  if (/\b(?:dearer|pricier|expensive|premium|nicer)\b/.test(lower) && filter.minMinor === undefined) {
    filter.dearer = true;
  }

  if (Object.keys(filter).length === 0) {
    return { kind: 'none', reason: 'narrowing words but nothing to narrow by' };
  }
  return { kind: 'filter', filter, reason: describe(filter) };
}

function describe(f: ProductFilter): string {
  const parts: string[] = [];
  if (f.colour !== undefined) parts.push(f.colour);
  if (f.maxMinor !== undefined) parts.push(`under ${f.maxMinor / 100}`);
  if (f.minMinor !== undefined) parts.push(`over ${f.minMinor / 100}`);
  if (f.cheaper === true) parts.push('cheaper');
  if (f.dearer === true) parts.push('dearer');
  return parts.join(' + ');
}

// ---------------------------------------------------------------------------
// Applying a filter to products the shopper can see
// ---------------------------------------------------------------------------

/**
 * The shape we read out of a catalog product.
 *
 * Structural rather than imported: these come back from UCP as plain JSON and
 * this module is deliberately free of any dependency on the catalog client.
 */
interface LooseProduct {
  readonly title?: unknown;
  readonly variants?: unknown;
  readonly options?: unknown;
}

/** Cheapest variant price in minor units, or undefined if none is readable. */
export function priceMinorOf(product: unknown): number | undefined {
  const variants = (product as LooseProduct)?.variants;
  if (!Array.isArray(variants)) return undefined;
  let best: number | undefined;
  for (const v of variants) {
    const raw =
      (v as { price?: unknown })?.price ??
      (v as { priceMinor?: unknown })?.priceMinor ??
      (v as { amount?: unknown })?.amount;
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number(raw.replace(/[^0-9.]/g, '')) * (raw.includes('.') ? 100 : 1)
          : typeof (raw as { amount?: unknown })?.amount === 'number'
            ? ((raw as { amount: number }).amount as number)
            : undefined;
    if (n !== undefined && Number.isFinite(n) && (best === undefined || n < best)) best = Math.round(n);
  }
  return best;
}

/** Does any of the product's text or variant options name this colour? */
export function mentionsColour(product: unknown, colour: string): boolean {
  const re = new RegExp(`\\b${colour}\\b`, 'i');
  const p = product as LooseProduct & Record<string, unknown>;
  if (typeof p.title === 'string' && re.test(p.title)) return true;
  if (Array.isArray(p.options)) {
    for (const o of p.options) {
      const values = (o as { values?: unknown })?.values;
      if (Array.isArray(values) && values.some((v) => typeof v === 'string' && re.test(v))) return true;
      const name = (o as { value?: unknown })?.value;
      if (typeof name === 'string' && re.test(name)) return true;
    }
  }
  if (Array.isArray(p.variants)) {
    for (const v of p.variants) {
      const title = (v as { title?: unknown })?.title;
      if (typeof title === 'string' && re.test(title)) return true;
      const selected = (v as { selectedOptions?: unknown })?.selectedOptions;
      if (Array.isArray(selected)) {
        if (selected.some((s) => typeof (s as { value?: unknown })?.value === 'string' && re.test(String((s as { value: string }).value)))) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Narrow a visible set. Never grows it, never reorders without being asked.
 *
 * Returns the products that survive. An empty result is meaningful to the
 * CALLER — it means "I cannot answer this from what is on screen" — and must be
 * handed to the model rather than reported as no matches.
 */
export function applyFilter(products: readonly unknown[], filter: ProductFilter): unknown[] {
  let out = products.slice();

  if (filter.colour !== undefined) {
    const colour = filter.colour;
    out = out.filter((p) => mentionsColour(p, colour) || (colour === 'grey' && mentionsColour(p, 'gray')));
  }
  if (filter.maxMinor !== undefined) {
    const max = filter.maxMinor;
    // A product whose price cannot be read is DROPPED by a price filter rather
    // than kept: showing something as "under fifty" without knowing its price
    // is the kind of claim the grounding layer exists to prevent.
    out = out.filter((p) => {
      const price = priceMinorOf(p);
      return price !== undefined && price <= max;
    });
  }
  if (filter.minMinor !== undefined) {
    const min = filter.minMinor;
    out = out.filter((p) => {
      const price = priceMinorOf(p);
      return price !== undefined && price >= min;
    });
  }

  // Relative asks rank the set instead of cutting it, so the shopper still sees
  // options. Products with no readable price sort last rather than vanishing.
  const rank = (a: unknown, b: unknown, sign: number): number => {
    const pa = priceMinorOf(a);
    const pb = priceMinorOf(b);
    if (pa === undefined && pb === undefined) return 0;
    if (pa === undefined) return 1;
    if (pb === undefined) return -1;
    return (pa - pb) * sign;
  };
  if (filter.cheaper === true) out.sort((a, b) => rank(a, b, 1));
  if (filter.dearer === true) out.sort((a, b) => rank(a, b, -1));

  return out;
}
