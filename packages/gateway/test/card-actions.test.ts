import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { Telemetry } from '../src/observability/telemetry.js';
import { MemorySessionStore } from '../src/sessions.js';

/**
 * Adding to the cart from a product card.
 *
 * The distinction this rests on: the deterministic lane refuses "add this",
 * because a sentence does not say which size and a wrong variant is discovered by
 * the shopper at checkout. A TAP carries an exact variant id, so the ambiguity
 * that made the text version unsafe is not present. Act where the input is
 * unambiguous, and only there.
 */

const WIDGET = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../public/widget.js'),
  'utf8',
).replace(/\r\n/g, '\n');

describe('POST /api/cart/add', () => {
  let server: Server;
  let base: string;
  let telemetry: Telemetry;

  beforeEach(async () => {
    telemetry = new Telemetry();
    server = createGateway({
      config: loadConfig({ OPENAI_API_KEY: 'sk-test', PORT: '0' }),
      telemetry,
      sessions: new MemorySessionStore(),
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const add = (body: unknown) =>
    fetch(`${base}/api/cart/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('adds a variant and says so', async () => {
    const res = await add({ sessionId: 's1', variantId: 'v-coat-m', quantity: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reply: string; sessionId: string };
    expect(body.ok).toBe(true);
    expect(body.reply).toMatch(/added/i);
    expect(body.sessionId).toBe('s1');
  });

  it('invents no subtotal when there is no cart to read', async () => {
    /**
     * Demo mode has no storefront behind it. A confirmation reading "Added —
     * £189.00" assembled from the widget's own copy of the price would be a total
     * nobody checked, which is the whole class of thing the grounding layer
     * exists to prevent.
     */
    const body = (await (await add({ sessionId: 's1', variantId: 'v-coat-m' })).json()) as {
      reply: string;
    };
    expect(body.reply).toBe('Added to your cart.');
    expect(body.reply).not.toMatch(/[$£€]/);
  });

  it('refuses a request with no variant', async () => {
    // "Add something" is not an instruction this endpoint can carry out.
    expect((await add({ sessionId: 's1' })).status).toBe(400);
    expect((await add({ sessionId: 's1', variantId: '' })).status).toBe(400);
    expect((await add({ sessionId: 's1', variantId: '   ' })).status).toBe(400);
  });

  it('refuses a variant id that is not shaped like one', async () => {
    // Client-supplied and passed to the storefront, so the shape is checked.
    for (const variantId of [
      'v-coat-m"><script>',
      'v coat m',
      '../../admin',
      'v'.repeat(300),
      'v\nid',
    ]) {
      expect((await add({ sessionId: 's1', variantId })).status, variantId.slice(0, 20)).toBe(400);
    }
  });

  it('accepts the id shapes Shopify actually uses', async () => {
    for (const variantId of [
      'gid://shopify/ProductVariant/123',
      'v-coat-m',
      'variant_42',
      'Z2lkOi8vc2hvcGlmeQ==',
    ]) {
      expect((await add({ sessionId: 's1', variantId })).status, variantId).toBe(200);
    }
  });

  it('bounds the quantity, and defaults anything odd to one', async () => {
    // A tap means one. A payload asking for 10,000 is not a shopper.
    for (const quantity of [0, -3, 2.5, 'lots', null, 99999]) {
      const res = await add({ sessionId: 's1', variantId: 'v-coat-m', quantity });
      expect(res.status, String(quantity)).toBe(200);
    }
  });

  it('is counted, so card adds are visible next to the rest of the lane', async () => {
    await add({ sessionId: 's1', variantId: 'v-coat-m' });
    expect(telemetry.fastLane.get({ shop: 'demo.local', intent: 'card_add' })).toBe(1);
  });

  it('spends no model tokens', async () => {
    await add({ sessionId: 's1', variantId: 'v-coat-m' });
    expect(telemetry.tokens.total()).toBe(0);
  });

  it('refuses a malformed body rather than throwing', async () => {
    const res = await fetch(`${base}/api/cart/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('does not answer a GET', async () => {
    const res = await fetch(`${base}/api/cart/add`);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the card only offers Add where a tap means one thing', () => {
  it('requires exactly one available variant', () => {
    /**
     * With two sizes in stock there is no way to know which the shopper wants,
     * and a wrong variant is found at checkout. So the button is not offered and
     * the card stays a link to the product page, where the choice belongs.
     */
    const fn = WIDGET.slice(WIDGET.indexOf('function soleVariant'), WIDGET.indexOf('async function addVariant'));
    expect(fn).toMatch(/open\.length === 1/);
    expect(fn).toMatch(/filter\(variantAvailable\)/);
    // And it needs an id to send.
    expect(fn).toMatch(/open\[0\]\.id/);
  });

  it('does not offer it on a sold-out product', () => {
    expect(WIDGET).toMatch(/if \(only && !allOut\)/);
  });

  it('does not let the button navigate the card', () => {
    // The card is an anchor to the product page; without this a tap on Add would
    // add AND leave.
    const fn = WIDGET.slice(WIDGET.indexOf("add.className = 'add'"), WIDGET.indexOf(".ph').appendChild(add)"));
    expect(fn).toMatch(/e\.preventDefault\(\)/);
    expect(fn).toMatch(/e\.stopPropagation\(\)/);
  });

  it('is appended rather than nested inside the anchor markup', () => {
    // A button inside a link is invalid nesting, and browsers resolve it in
    // ways that break one or the other.
    expect(WIDGET).toMatch(/c\.querySelector\('\.ph'\)\.appendChild\(add\)/);
  });

  it('shows the server’s confirmation, not one it wrote itself', () => {
    const fn = WIDGET.slice(WIDGET.indexOf('async function addVariant'), WIDGET.indexOf('function variantAvailable'));
    expect(fn).toMatch(/addMsg\('bot', d\.reply/);
    // No price formatting anywhere in this function.
    expect(fn).not.toMatch(/money\(/);
  });

  it('says something when it fails, and names the product', () => {
    // A dead button the shopper pressed is worse than no button; "that didn't
    // work" beside four cards says nothing about which.
    const fn = WIDGET.slice(WIDGET.indexOf('async function addVariant'), WIDGET.indexOf('function variantAvailable'));
    expect(fn).toMatch(/I couldn’t add the/);
    expect(fn).toMatch(/title \|\| 'item'/);
  });

  it('stays disabled after a successful add', () => {
    // Tapping again would add a second one, which is almost never what a tap
    // meant.
    expect(WIDGET).toMatch(/add\.disabled = ok/);
  });

  it('is visible without hover, because most shoppers are on a phone', () => {
    const css = WIDGET.slice(WIDGET.indexOf('.card .add{'), WIDGET.indexOf('.card .meta{'));
    expect(css).not.toMatch(/opacity:0/);
    expect(css).toMatch(/position:absolute/);
  });
});
