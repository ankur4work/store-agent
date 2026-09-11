/**
 * Show the variant the shopper asked about, not the one the merchant
 * featured.
 *
 * A shopper asked for white sneakers. The answer was exactly right —
 * "Canvas Low-Top Sneakers are the cheapest white sneakers at $49.99,
 * available in sizes 6 to 11" — and the card beneath it showed the red and
 * black colourway, because that is the product's primary image in Shopify.
 *
 * Correct words under a contradicting picture is worse than no picture.
 * People believe the photograph: the shopper sees red shoes and concludes
 * the assistant cannot tell colours apart, and nothing in the text can
 * recover from that.
 *
 * So when the conversation names a variant this store actually has, the
 * card is switched to that variant's own photograph. Deterministic, and
 * only ever a swap between images that already belong to the product.
 */

interface VariantLike {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly options?: unknown;
  readonly media?: unknown;
  readonly image?: unknown;
}

/** Every option value on a variant: "White", "Large", "Tan Leather". */
function optionValues(variant: VariantLike): string[] {
  const out: string[] = [];
  const options = variant.options;

  if (Array.isArray(options)) {
    for (const o of options) {
      const label = (o as { label?: unknown; value?: unknown })?.label ?? (o as { value?: unknown })?.value;
      if (typeof label === 'string' && label !== '') out.push(label);
    }
  } else if (options !== null && typeof options === 'object') {
    // The flat `{ Size: 'M', Colour: 'White' }` shape.
    for (const v of Object.values(options as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') out.push(v);
    }
  }

  // A variant title is often "White / 9" where options are absent.
  if (typeof variant.title === 'string' && variant.title !== '' && variant.title !== 'Default Title') {
    out.push(...variant.title.split('/').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

function firstImage(variant: VariantLike): string {
  if (typeof variant.image === 'string' && variant.image !== '') return variant.image;
  for (const m of Array.isArray(variant.media) ? variant.media : []) {
    const url = (m as { url?: unknown })?.url;
    if (typeof url === 'string' && url !== '') return url;
  }
  return '';
}

/**
 * The image to show for this product, given what was said.
 *
 * Returns '' when nothing in the conversation names a variant, which
 * leaves the product's own primary image in place — the right default when
 * the shopper has expressed no preference.
 *
 * Matched on whole words. A substring test makes "red" match "prepared"
 * and, worse, "white" match nothing while "hite" matches everything; and
 * it would let a size of "8" select a variant because the price contains
 * an eight.
 */
export function variantImageFor(product: unknown, saidText: string): string {
  const variants = (product as { variants?: unknown })?.variants;
  if (!Array.isArray(variants) || variants.length < 2) return '';

  const said = ` ${saidText.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ')} `;

  let best = '';
  let bestScore = 0;
  for (const variant of variants as VariantLike[]) {
    const image = firstImage(variant);
    if (image === '') continue;

    // Count how many of this variant's option values were mentioned. The
    // count breaks ties: "white size 9" should pick the white 9, not the
    // first white it sees.
    let score = 0;
    for (const value of optionValues(variant)) {
      const needle = value.toLowerCase().trim();
      // No minimum length. An earlier version skipped anything under two
      // characters to avoid noise and thereby excluded every single-digit
      // shoe size and "S"/"M"/"L" — the option values shoppers name most
      // often. The whole-word match is what makes short values safe: " 9 "
      // cannot match the 9 inside a price or an sku.
      if (needle === '') continue;
      if (said.includes(` ${needle} `)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = image;
    }
  }
  return best;
}

/**
 * Attach `display_image` to each product, chosen from the conversation.
 *
 * A new field rather than overwriting `image`: grounding validates against
 * the payload, the widget renders from it, and quietly rewriting a field
 * both read is how a display choice turns into a data error.
 */
export function withVariantImages<T>(products: readonly T[], saidText: string): T[] {
  return products.map((p) => {
    const image = variantImageFor(p, saidText);
    return image === '' ? p : ({ ...(p as object), display_image: image } as T);
  });
}
