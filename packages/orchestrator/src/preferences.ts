/**
 * What the shopper has already told us.
 *
 * ## The rule this exists to keep
 *
 * "Never ask for something the shopper has already given you." The prompt says
 * it, and until now the prompt could not keep it: nothing carried an answer
 * forward. History is capped at 24 messages and the model re-reads it every
 * turn, but a size mentioned in passing eight turns ago competes with everything
 * else in that window — so the assistant asks again, and being asked your size
 * twice is the moment a shopper decides the thing is not listening.
 *
 * So preferences are extracted deterministically, stored on the session, and
 * rendered into the turn context as a short, explicit line. The model then
 * cannot miss them, and cannot spend attention re-deriving them.
 *
 * ## Why extraction is deterministic and not a model call
 *
 * A classifier turn per message would double the cost of every turn to learn
 * something a regex finds in microseconds — and it would introduce a way to
 * invent a preference the shopper never stated. "I'm a medium" is not ambiguous.
 * Where it IS ambiguous, nothing is recorded: that is strictly better than a
 * confident wrong memory, because a wrong remembered size silently narrows
 * every subsequent recommendation and the shopper never learns why.
 *
 * ## What is deliberately not remembered
 *
 * Anything a shopper would be unsettled to find the assistant knew. This holds
 * size, budget, colour and occasion — facts they volunteered about a purchase,
 * for half an hour, in the session that hears them. Not names, not gender, not
 * anything about a body beyond a garment size, and never anything inferred from
 * behaviour rather than stated outright.
 */

export interface Preferences {
  /** A garment or shoe size, as the shopper said it. */
  size?: string;
  /** Upper bound in minor units. */
  budgetMaxMinor?: number;
  /** A colour they asked for. */
  colour?: string;
  /** What they are shopping for: a wedding, work, running. */
  occasion?: string;
}

/** Sizes we recognise. Word forms and the common letter/number forms. */
const SIZE_WORDS: Readonly<Record<string, string>> = {
  'extra small': 'XS',
  'x small': 'XS',
  xs: 'XS',
  small: 'S',
  medium: 'M',
  large: 'L',
  'extra large': 'XL',
  'x large': 'XL',
  xl: 'XL',
  xxl: 'XXL',
};

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

const OCCASIONS: readonly string[] = [
  'wedding',
  'work',
  'office',
  'running',
  'hiking',
  'gym',
  'holiday',
  'beach',
  'party',
  'interview',
  'funeral',
  'travel',
  'winter',
  'summer',
  'skiing',
  'snowboarding',
];

/**
 * A stated size, and only a stated one.
 *
 * Requires the shopper to be talking about themselves — "I'm a medium", "I take
 * a 9". A bare "medium" is not enough: it is also a coffee, a heat setting, and
 * half of "medium blue". And "do you have a large" is a question about stock
 * rather than a statement about the person asking, so it is not recorded either.
 */
/**
 * The size itself is an explicit alternation, not a loose character run.
 *
 * A permissive class with a lazy quantifier read "I take a 9.5" as size 9 — it
 * stopped at the first boundary it could — and it missed "I'm a medium and…"
 * entirely, because the clause it required afterwards never arrived. Naming the
 * forms we accept removes both failure modes and the guesswork with them.
 *
 * Ordered longest-first so "extra large" is not read as "large", and bounded to
 * two digits so "size 2026" matches nothing rather than becoming size 20.
 */
const SIZE_CLAIM = new RegExp(
  String.raw`\b(?:i(?:'m| am)(?: a| an)?|i take(?: a| an)?|i wear(?: a| an)?|my size is|size)\s+` +
    String.raw`((?:uk|us|eu) ?\d{1,2}(?:\.5)?|\d{1,2}(?:\.5|½)?|extra small|x small|extra large|x large|xxl|xs|xl|small|medium|large)\b`,
  'i',
);

const SIZE_ASKS_STOCK = /\b(?:do you have|got any|is there|have you got|any)\b/i;

export function extractPreferences(message: string): Preferences {
  const text = message.trim();
  if (text === '') return {};
  const lower = text.toLowerCase();
  const found: Preferences = {};

  // --- size ---------------------------------------------------------------
  if (!SIZE_ASKS_STOCK.test(lower)) {
    const m = SIZE_CLAIM.exec(lower);
    const raw = m?.[1]?.trim();
    if (raw !== undefined && raw !== '') {
      const word = SIZE_WORDS[raw];
      if (word !== undefined) found.size = word;
      // A numeric size: "9", "9.5", "42". Bounded, so a price or a year cannot
      // become a shoe size.
      else if (/^\d{1,2}(?:\.5|½)?$/.test(raw)) found.size = raw.replace('½', '.5');
      else if (/^(?:uk|us|eu)\s?\d{1,2}(?:\.5)?$/.test(raw)) found.size = raw.toUpperCase();
    }
  }

  // --- budget -------------------------------------------------------------
  //
  // Only an upper bound, and only when it is framed as one. "it's £200" is a
  // statement about a product, not a budget, and recording it would cap every
  // later recommendation at a number the shopper never set.
  const budget =
    /\b(?:under|below|less than|up to|no more than|max(?:imum)?|budget(?: of)?|around|about)\s*(?:[$£€]\s*)?(\d{1,5}(?:\.\d{1,2})?)\b/i.exec(
      text,
    );
  if (budget) {
    const value = Number(budget[1]);
    if (Number.isFinite(value) && value > 0) found.budgetMaxMinor = Math.round(value * 100);
  }

  // --- colour -------------------------------------------------------------
  //
  /**
   * Requires the shopper to be expressing a preference, not asking a question.
   *
   * A bare "in" was in this list and matched "is the black one IN stock" — so
   * asking whether something was available became a standing instruction to only
   * ever show black. A question is not a preference, and the cost of missing one
   * genuine "in navy please" is one turn; the cost of the false positive is every
   * subsequent recommendation silently filtered.
   */
  if (/\b(?:i(?:'d| would)? (?:like|prefer|want)|i like|looking for|prefer|rather have)\b/i.test(lower)) {
    const colour = COLOURS.find((c) => new RegExp(`\\b${c}\\b`).test(lower));
    if (colour !== undefined) found.colour = colour === 'gray' ? 'grey' : colour;
  }

  // --- occasion -----------------------------------------------------------
  const occasion = OCCASIONS.find((o) => new RegExp(`\\b${o}\\b`).test(lower));
  if (occasion !== undefined) found.occasion = occasion;

  return found;
}

/**
 * Fold what was just said into what we already knew.
 *
 * The newer statement wins. A shopper who says "actually, make it black" has
 * changed their mind, and the prompt's rule 12 — "if the shopper changes
 * direction, update context" — is this function. Nothing is ever removed by
 * silence: not mentioning a size again does not mean they forgot it.
 */
export function mergePreferences(known: Preferences, heard: Preferences): Preferences {
  return { ...known, ...heard };
}

/**
 * Render preferences for the LAST USER TURN, never the cached prefix.
 *
 * This is per-shopper, so putting it in the prefix would give every shopper
 * their own cached prompt and destroy the hit rate §7.4 depends on. It belongs
 * with the page and the cart, in the volatile block.
 *
 * Phrased as facts the shopper stated, with an explicit instruction not to ask
 * again — because the failure being fixed is not the model forgetting, it is the
 * model asking anyway.
 */
export function renderPreferences(prefs: Preferences): string {
  const parts: string[] = [];
  if (prefs.size !== undefined) parts.push(`size ${prefs.size}`);
  if (prefs.budgetMaxMinor !== undefined) parts.push(`budget up to ${(prefs.budgetMaxMinor / 100).toFixed(2)}`);
  if (prefs.colour !== undefined) parts.push(`prefers ${prefs.colour}`);
  if (prefs.occasion !== undefined) parts.push(`shopping for: ${prefs.occasion}`);
  if (parts.length === 0) return '';
  return `The shopper has already told you: ${parts.join(', ')}. Do not ask for any of these again.`;
}
