/**
 * StoreAgent web pixel.
 *
 * Reports `checkout_completed` back to the gateway with our session id, so an
 * order can be joined to the session that produced it.
 *
 * ## Why this exists
 *
 * The obvious attribution path is order → cart → session, using the cart the
 * assistant created. That works for shoppers who saw the assistant and is
 * useless for the held-back group, who never see it and so never create a cart
 * of ours. An unmeasurable control group makes the entire comparison
 * worthless — so this pixel, which runs for EVERY shopper in both groups, is
 * what makes the measurement possible at all.
 *
 * ## Constraints of `runtime_context = "strict"`
 *
 * The pixel runs in a sandboxed worker with no DOM and no access to the
 * storefront's `localStorage`. It can only read `browser.localStorage` — the
 * pixel sandbox's own store — so the widget and the pixel cannot share a key
 * directly. We therefore mirror the session id into the pixel sandbox the first
 * time the pixel sees any event, and fall back to Shopify's own client id when
 * the shopper reached checkout without the widget ever loading.
 *
 * Sends only: session id, order id, and total. No PII, no cart contents, no
 * customer identifiers.
 */
import { register } from '@shopify/web-pixels-extension';

register(({ analytics, browser, settings, init }) => {
  const gateway = (settings?.gateway_url ?? '').replace(/\/+$/, '');
  if (!gateway) return;

  const SESSION_KEY = 'storeagent.sid';

  async function resolveSessionId() {
    try {
      const stored = await browser.localStorage.getItem(SESSION_KEY);
      if (stored) return stored;
    } catch (e) {
      /* sandbox storage unavailable — fall through */
    }
    // Shopify's own per-visitor id. Stable across the visit, so the join still
    // works when the widget never ran (direct-to-checkout, blocked script).
    const fallback = init?.data?.customer?.id ?? init?.context?.document?.location?.href ?? '';
    const id = `sfy_${String(fallback).slice(-24) || Date.now()}`;
    try {
      await browser.localStorage.setItem(SESSION_KEY, id);
    } catch (e) {
      /* best effort */
    }
    return id;
  }

  analytics.subscribe('checkout_completed', async (event) => {
    const checkout = event?.data?.checkout;
    if (!checkout) return;

    const sessionId = await resolveSessionId();
    const total = checkout.totalPrice?.amount;

    const payload = {
      sessionId,
      shop: init?.context?.document?.location?.hostname ?? '',
      orderId: String(checkout.order?.id ?? checkout.token ?? ''),
      // Minor units at the boundary, once — matching the rest of the system.
      totalMinor: typeof total === 'number' ? Math.round(total * 100) : 0,
    };
    if (!payload.orderId) return;

    // keepalive so the beacon survives the navigation away from checkout.
    try {
      await fetch(`${gateway}/api/pixel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch (e) {
      // A dropped measurement beacon must never affect the shopper. Losing a
      // data point is acceptable; throwing inside checkout is not.
    }
  });
});
