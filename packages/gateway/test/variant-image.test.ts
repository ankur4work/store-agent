import { describe, expect, it } from 'vitest';
import { variantImageFor, withVariantImages } from '../src/search/variant-image.js';

/**
 * A shopper asked for white sneakers. The answer was exactly right —
 * "Canvas Low-Top Sneakers are the cheapest white sneakers at $49.99,
 * available in sizes 6 to 11" — and the card beneath showed the red and
 * black colourway, because that is the product's primary image.
 *
 * Correct words under a contradicting picture is worse than no picture.
 * The shopper sees red shoes and concludes the assistant cannot tell
 * colours apart, and no amount of text recovers from that.
 */
const SNEAKER = {
  id: 'p1',
  title: 'Canvas Low-Top Sneakers',
  image: 'https://cdn/red-primary.jpg',
  variants: [
    { id: 'v-red', options: [{ name: 'Colour', label: 'Red' }], media: [{ url: 'https://cdn/red.jpg' }] },
    { id: 'v-white', options: [{ name: 'Colour', label: 'White' }], media: [{ url: 'https://cdn/white.jpg' }] },
    { id: 'v-black', options: [{ name: 'Colour', label: 'Black' }], media: [{ url: 'https://cdn/black.jpg' }] },
  ],
};

describe('showing the variant the shopper asked about', () => {
  it('picks the colour named in the conversation', () => {
    expect(variantImageFor(SNEAKER, 'white sneakers')).toBe('https://cdn/white.jpg');
    expect(variantImageFor(SNEAKER, 'do you have these in black')).toBe('https://cdn/black.jpg');
  });

  it('leaves the primary image alone when no variant was named', () => {
    // No preference expressed is exactly when the merchant's own choice of
    // hero image is the right one.
    expect(variantImageFor(SNEAKER, 'how much are the sneakers')).toBe('');
  });

  it('prefers the variant matching the most of what was said', () => {
    const sized = {
      id: 'p2',
      variants: [
        { id: 'a', options: [{ label: 'White' }, { label: '8' }], media: [{ url: 'https://cdn/w8.jpg' }] },
        { id: 'b', options: [{ label: 'White' }, { label: '9' }], media: [{ url: 'https://cdn/w9.jpg' }] },
      ],
    };
    expect(variantImageFor(sized, 'white in a 9 please')).toBe('https://cdn/w9.jpg');
  });

  it('matches whole words, not fragments', () => {
    // A substring test makes "red" match "prepared" and picks the red shoe
    // for a sentence about being prepared for winter.
    expect(variantImageFor(SNEAKER, 'are these prepared for winter')).toBe('');
  });

  it('reads a "White / 9" variant title when there are no options', () => {
    const titled = {
      id: 'p3',
      variants: [
        { id: 'a', title: 'Red / 8', media: [{ url: 'https://cdn/r8.jpg' }] },
        { id: 'b', title: 'White / 9', media: [{ url: 'https://cdn/w9.jpg' }] },
      ],
    };
    expect(variantImageFor(titled, 'the white ones')).toBe('https://cdn/w9.jpg');
  });

  it('ignores a single-variant product, which has nothing to choose between', () => {
    const one = { id: 'p4', variants: [{ id: 'a', title: 'Default Title', media: [{ url: 'x.jpg' }] }] };
    expect(variantImageFor(one, 'white')).toBe('');
  });

  it('ignores a variant with no photograph of its own', () => {
    const noMedia = {
      id: 'p5',
      variants: [
        { id: 'a', options: [{ label: 'White' }] },
        { id: 'b', options: [{ label: 'Red' }], media: [{ url: 'https://cdn/red.jpg' }] },
      ],
    };
    expect(variantImageFor(noMedia, 'white please')).toBe('');
  });

  it('adds display_image without touching the fields grounding reads', () => {
    // Overwriting `image` would turn a display choice into a data edit, in
    // a payload the validator checks and the cards render from.
    const [out] = withVariantImages([SNEAKER], 'white sneakers') as unknown as { image: string; display_image: string }[];
    expect(out!.display_image).toBe('https://cdn/white.jpg');
    expect(out!.image).toBe('https://cdn/red-primary.jpg');
  });

  it('leaves a product untouched when nothing matches', () => {
    const [out] = withVariantImages([SNEAKER], 'how much') as Record<string, unknown>[];
    expect(out!['display_image']).toBeUndefined();
  });
});
