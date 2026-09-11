/**
 * Reading the product photo, because the merchant did not write it down.
 *
 * Semantic search over product text can only find what someone typed. A
 * shopper asking for "open-toe shoes", "a black bag with a gold chain" or
 * "a board with trees on it" is describing the PICTURE — and for most
 * catalogs that description exists nowhere in the data. Merchants write
 * "Riviera Sandal", not "open toe, ankle strap, tan leather".
 *
 * So the picture is read once, turned into the words a shopper would use,
 * and indexed alongside the merchant's own text. That is the difference
 * between a catalog that answers "what do you have in blue" and one that
 * shrugs.
 *
 * Cached by image URL forever. Shopify's CDN URLs carry a version query, so
 * a re-uploaded photo is a new URL and re-read automatically, while a
 * re-index of an unchanged catalog costs nothing.
 */

export interface VisionConfig {
  readonly apiKey: string;
  /** Must accept images. Verified: gpt-5.4-mini, ~1.4s and pennies per image. */
  readonly model?: string;
  readonly doFetch?: typeof globalThis.fetch;
}

export const DEFAULT_VISION_MODEL = 'gpt-5.4-mini';

/**
 * Deliberately a vocabulary list, not prose.
 *
 * Everything here exists to make the output MATCHABLE rather than readable.
 * Sentences embed toward "this is a product description" and blunt the
 * distinctions that matter; a bare list of attributes keeps "open toe" and
 * "closed toe" far apart in the space.
 *
 * "Only what is visible" is the load-bearing instruction. A model asked to
 * describe a product will happily infer a brand, a price bracket or a
 * material it cannot see, and an invented attribute indexed as fact is a
 * shopper being shown a linen dress that is polyester.
 */
const PROMPT =
  'List the VISIBLE attributes of this product as short comma-separated phrases. ' +
  'Cover, where visible: colours (name every distinct one), material and texture, ' +
  'pattern or graphic, shape and silhouette, and notable details — necklines, sleeve ' +
  'length, toe shape, heel, straps, buckles, chains, hardware, closures, pockets. ' +
  'Use the everyday words a shopper would say. No sentences, no marketing language, ' +
  'no brand or price. Describe ONLY what you can see; omit anything you are unsure of.';

/**
 * The attributes visible in a product photo, as a comma-separated string.
 * Returns '' on any failure — an unreadable image must degrade the index,
 * never fail the build.
 */
export async function describeImage(url: string, cfg: VisionConfig): Promise<string> {
  if (url === '') return '';
  const doFetch = cfg.doFetch ?? fetch;
  try {
    const res = await doFetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model ?? DEFAULT_VISION_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              // "low" detail: a product shot on white needs no more, and it
              // is several times cheaper per image across a whole catalog.
              { type: 'image_url', image_url: { url, detail: 'low' } },
            ],
          },
        ],
        max_completion_tokens: 160,
      }),
    });
    if (!res.ok) return '';
    const body = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const text = body.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  } catch {
    return '';
  }
}

/** Where a described image is remembered, so it is read once per photo. */
export interface VisionCache {
  get(imageUrl: string): string | undefined;
  put(imageUrl: string, attributes: string): void;
}

/** The first image on a product, in whichever shape the payload uses. */
export function primaryImage(product: unknown): string {
  const p = product as { image?: unknown; media?: unknown; variants?: unknown };
  if (typeof p?.image === 'string' && p.image !== '') return p.image;

  for (const m of Array.isArray(p?.media) ? p.media : []) {
    const url = (m as { url?: unknown })?.url;
    if (typeof url === 'string' && url !== '') return url;
  }
  for (const v of Array.isArray(p?.variants) ? p.variants : []) {
    for (const m of Array.isArray((v as { media?: unknown })?.media) ? (v as { media: unknown[] }).media : []) {
      const url = (m as { url?: unknown })?.url;
      if (typeof url === 'string' && url !== '') return url;
    }
  }
  return '';
}

/**
 * Describe many images, cache-first, with a small concurrency cap.
 *
 * The cap is not politeness — a hundred-product catalog fired at once will
 * be rate-limited, and a rate-limited build silently indexes half a shop.
 */
export async function describeAll(
  urls: readonly string[],
  cache: VisionCache,
  cfg: VisionConfig,
  concurrency = 4,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo: string[] = [];

  for (const url of new Set(urls)) {
    if (url === '') continue;
    const hit = cache.get(url);
    if (hit === undefined) todo.push(url);
    else out.set(url, hit);
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const url = todo[next++]!;
      const described = await describeImage(url, cfg);
      // Cached even when empty: a photo that cannot be read will not become
      // readable on the next rebuild, and retrying it every six hours is a
      // standing bill for nothing.
      cache.put(url, described);
      out.set(url, described);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return out;
}
