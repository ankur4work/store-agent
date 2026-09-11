/**
 * Turning catalog text and shopper questions into vectors.
 *
 * Keyword search answers "which product contains these words". A shopper
 * asks "open-toe shoes", "a black bag with a gold chain", "something warm
 * for a wedding" — descriptions whose words appear nowhere in the product
 * text. The word overlap is zero and the search returns nothing, in a shop
 * full of things that match.
 *
 * An embedding puts meaning in the same space as words, so "open-toe" lands
 * near "sandal" and "slingback" without either sharing a character.
 */

/** 1536 dimensions, and by a wide margin the cheapest thing in this app. */
export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMS = 1536;

/** Above this the API rejects the batch outright. */
const MAX_BATCH = 96;

export class EmbeddingError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

export interface EmbeddingConfig {
  readonly apiKey: string;
  readonly model?: string;
  readonly doFetch?: typeof globalThis.fetch;
}

/**
 * Embed a batch of texts, in order.
 *
 * Empty strings are embedded as zero vectors rather than sent: the API
 * rejects them, and one product with a blank description would otherwise
 * fail the whole catalog build.
 */
export async function embed(
  texts: readonly string[],
  cfg: EmbeddingConfig,
): Promise<Float32Array[]> {
  const out: Float32Array[] = new Array(texts.length);
  const wanted: { index: number; text: string }[] = [];

  texts.forEach((t, i) => {
    const trimmed = t.trim();
    if (trimmed === '') out[i] = new Float32Array(EMBEDDING_DIMS);
    else wanted.push({ index: i, text: trimmed.slice(0, 8000) });
  });

  const doFetch = cfg.doFetch ?? fetch;

  for (let start = 0; start < wanted.length; start += MAX_BATCH) {
    const batch = wanted.slice(start, start + MAX_BATCH);
    const res = await doFetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.model ?? EMBEDDING_MODEL, input: batch.map((b) => b.text) }),
    });

    if (!res.ok) {
      // Retryable on the transient classes only — a 400 means the input is
      // wrong and repeating it wastes a shopper's turn.
      const retryable = res.status === 429 || res.status >= 500;
      const detail = await res
        .text()
        .then((t) => t.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]').slice(0, 200))
        .catch(() => '');
      throw new EmbeddingError(`embeddings failed (${res.status}): ${detail}`, retryable);
    }

    const body = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
    for (const row of body.data ?? []) {
      const target = batch[row.index];
      if (target !== undefined) out[target.index] = Float32Array.from(row.embedding);
    }
  }

  // A gap here means the API returned fewer rows than asked for. Better an
  // error than a catalog silently missing the product nobody can find.
  for (let i = 0; i < out.length; i++) {
    if (out[i] === undefined) throw new EmbeddingError('embeddings returned an incomplete batch', true);
  }
  return out;
}

/**
 * Cosine similarity of two vectors.
 *
 * Not normalised ahead of time on purpose: the API already returns unit
 * vectors, so the denominator is ~1, but computing it costs one pass and
 * removes the assumption. Returns 0 for a zero vector rather than NaN — a
 * product with no text should rank last, not poison the sort.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Float32Array <-> BLOB, for storage. Little-endian, platform-independent. */
export function vectorToBlob(v: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i]!, i * 4);
  return buf;
}

export function blobToVector(b: Uint8Array): Float32Array {
  const view = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const out = new Float32Array(Math.floor(b.byteLength / 4));
  for (let i = 0; i < out.length; i++) out[i] = view.readFloatLE(i * 4);
  return out;
}
