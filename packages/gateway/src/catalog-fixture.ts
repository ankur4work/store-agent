/**
 * Demo catalog, used when no SHOP_DOMAIN is configured.
 *
 * This exists so the gateway is runnable today — we still have no Shopify
 * development store, and blocking the whole app on that would be silly. The
 * shape is exactly what UCP `search_catalog` returns (prices in MINOR units),
 * so switching to a real store changes configuration, not code.
 */
export interface DemoProduct {
  id: string;
  title: string;
  description: string;
  image: string;
  price_range: { min: { amount: number; currency: string }; max: { amount: number; currency: string } };
  variants: {
    id: string;
    title: string;
    price: { amount: number; currency: string };
    available: boolean;
    options?: Record<string, string>;
  }[];
  rating?: { value: number; count: number };
}

export const DEMO_CATALOG: DemoProduct[] = [
  {
    id: 'gid://shopify/Product/1',
    title: 'Merino Wool Overcoat',
    description: 'Full-length water-resistant merino overcoat with a half-canvas front.',
    image: 'https://placehold.co/400x500/2b2b2b/f4f1ea?text=Overcoat',
    price_range: { min: { amount: 18900, currency: 'USD' }, max: { amount: 18900, currency: 'USD' } },
    variants: [
      { id: 'v-coat-s', title: 'S', price: { amount: 18900, currency: 'USD' }, available: true, options: { Size: 'S' } },
      { id: 'v-coat-m', title: 'M', price: { amount: 18900, currency: 'USD' }, available: true, options: { Size: 'M' } },
      { id: 'v-coat-l', title: 'L', price: { amount: 18900, currency: 'USD' }, available: false, options: { Size: 'L' } },
    ],
    rating: { value: 4.6, count: 212 },
  },
  {
    id: 'gid://shopify/Product/2',
    title: 'Cashmere Scarf',
    description: 'Two-ply Mongolian cashmere, 180cm, hand-finished edges.',
    image: 'https://placehold.co/400x500/6b5b4b/f4f1ea?text=Scarf',
    price_range: { min: { amount: 7900, currency: 'USD' }, max: { amount: 7900, currency: 'USD' } },
    variants: [
      { id: 'v-scarf-grey', title: 'Grey', price: { amount: 7900, currency: 'USD' }, available: true },
      { id: 'v-scarf-navy', title: 'Navy', price: { amount: 7900, currency: 'USD' }, available: true },
    ],
    rating: { value: 4.9, count: 88 },
  },
  {
    id: 'gid://shopify/Product/3',
    title: 'Leather Gloves',
    description: 'Lambskin gloves with cashmere lining and touchscreen fingertips.',
    image: 'https://placehold.co/400x500/4a3728/f4f1ea?text=Gloves',
    price_range: { min: { amount: 5400, currency: 'USD' }, max: { amount: 5400, currency: 'USD' } },
    variants: [
      { id: 'v-glove-m', title: 'M', price: { amount: 5400, currency: 'USD' }, available: true },
      { id: 'v-glove-l', title: 'L', price: { amount: 5400, currency: 'USD' }, available: true },
    ],
  },
  {
    id: 'gid://shopify/Product/4',
    title: 'Rain Shell',
    description: 'Three-layer waterproof shell, taped seams, packs into its own pocket.',
    image: 'https://placehold.co/400x500/1f3a3d/f4f1ea?text=Shell',
    price_range: { min: { amount: 12500, currency: 'USD' }, max: { amount: 12500, currency: 'USD' } },
    variants: [
      { id: 'v-shell-s', title: 'S', price: { amount: 12500, currency: 'USD' }, available: true },
      { id: 'v-shell-m', title: 'M', price: { amount: 12500, currency: 'USD' }, available: false },
    ],
    rating: { value: 4.3, count: 47 },
  },
];

export const DEMO_POLICIES: Record<string, string> = {
  shipping:
    'Standard shipping is free over $75 and arrives in 3-5 business days. Express is $12 and arrives next business day if ordered before 2pm.',
  returns:
    'Returns are accepted within 30 days of delivery, unworn with tags attached. Return shipping is free; refunds are issued within 5 business days of receipt.',
  warranty: 'All outerwear carries a two-year warranty against manufacturing defects.',
  payment: 'We accept all major cards, Shop Pay, Apple Pay, and Google Pay.',
  faq: 'Our wool is mulesing-free and sourced from certified suppliers in New Zealand.',
};

export function searchDemoCatalog(query: string, limit = 6): { products: DemoProduct[] } {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (q.length === 0) return { products: DEMO_CATALOG.slice(0, limit) };

  const scored = DEMO_CATALOG.map((p) => {
    const hay = `${p.title} ${p.description}`.toLowerCase();
    return { p, score: q.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // Fall back to the full catalog rather than nothing — an empty result makes
  // the model apologise when it could have offered alternatives.
  return { products: (scored.length > 0 ? scored.map((x) => x.p) : DEMO_CATALOG).slice(0, limit) };
}
