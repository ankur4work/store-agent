/**
 * What a product looks like to the search index.
 *
 * The single highest-leverage decision in semantic search is not the model
 * or the index — it is what text goes in. A vector of the title alone
 * cannot match "open-toe shoes", because the answer lives in the
 * description, the tags and the option names.
 *
 * `read_products` is what makes this possible: the catalog payload carries
 * the description, product type, vendor, tags, option names and every
 * variant's option values. That is the merchant's own vocabulary for the
 * product, and it is where colour, material, cut, occasion and fit are
 * actually written.
 */

interface ProductLike {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly product_type?: unknown;
  readonly vendor?: unknown;
  readonly tags?: unknown;
  readonly options?: unknown;
  readonly variants?: unknown;
}

/** Descriptions arrive as `{html}` or a bare string depending on the field. */
function plainText(value: unknown): string {
  const raw =
    typeof value === 'string'
      ? value
      : typeof (value as { html?: unknown })?.html === 'string'
        ? ((value as { html: string }).html)
        : '';
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * The indexed text for one product.
 *
 * Title first and repeated once. Embeddings weight the whole string evenly,
 * and without it a long description drowns the name — "Hydrogen" stops
 * matching "the Hydrogen board" because it is one word in three hundred.
 *
 * Option VALUES matter more than option names: "Ice, Dawn, Powder" is what
 * a shopper describes when they ask for a colour, and it is the part a
 * keyword search over titles never sees.
 */
export function productText(product: unknown): string {
  if (product === null || typeof product !== 'object') return '';
  const p = product as ProductLike;

  const parts: string[] = [];
  const title = typeof p.title === 'string' ? p.title : '';
  if (title !== '') parts.push(title, title);

  if (typeof p.product_type === 'string' && p.product_type !== '') parts.push(p.product_type);
  if (typeof p.vendor === 'string' && p.vendor !== '') parts.push(p.vendor);

  const tags = strings(p.tags);
  if (tags.length > 0) parts.push(tags.join(', '));

  // Option names and their values: "Colour: Ice, Dawn, Powder".
  for (const option of Array.isArray(p.options) ? p.options : []) {
    const o = option as { name?: unknown; values?: unknown };
    const name = typeof o.name === 'string' ? o.name : '';
    const values = (Array.isArray(o.values) ? o.values : [])
      .map((v) => (typeof v === 'string' ? v : ((v as { label?: unknown })?.label ?? '')))
      .filter((v): v is string => typeof v === 'string' && v !== '');
    if (values.length > 0) parts.push(`${name}: ${values.join(', ')}`);
    else if (name !== '') parts.push(name);
  }

  // Variant titles carry the same vocabulary on stores that do not declare
  // options properly, which is most of them.
  const variantTitles = (Array.isArray(p.variants) ? p.variants : [])
    .map((v) => (v as { title?: unknown })?.title)
    .filter((t): t is string => typeof t === 'string' && t !== '' && t !== 'Default Title');
  if (variantTitles.length > 0) parts.push([...new Set(variantTitles)].join(', '));

  const description = plainText(p.description);
  // Truncated: past a few hundred words a description is shipping boilerplate
  // repeated on every product, which pushes every vector toward every other.
  if (description !== '') parts.push(description.slice(0, 1200));

  return parts.join('. ');
}

/** Stable id for a product, or '' when it has none to key on. */
export function productId(product: unknown): string {
  const id = (product as ProductLike)?.id;
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : '';
}
