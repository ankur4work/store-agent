/**
 * Shopify App Pricing ("managed pricing").
 *
 * Two ways an app can bill, and only one may be in charge:
 *
 *   - **Manual** — the app calls `appSubscriptionCreate` itself and sends the
 *     merchant to approve. That is what `BillingService.beginUpgrade` does.
 *   - **Managed** — Shopify hosts the plan picker and creates the subscription.
 *     The app never creates one; it links the merchant to Shopify's page.
 *
 * Doing both is the failure this module exists to prevent: the merchant picks a
 * plan in our UI, we create a subscription Shopify's managed pricing did not
 * expect, and the two disagree about what the merchant is on. Shopify's
 * readiness checklist for the switch is essentially "confirm you stopped
 * creating subscriptions".
 *
 * What does NOT change: `reconcile()` and the `app_subscriptions/update`
 * webhook both READ subscription state, and read paths are identical under
 * either mode. Shopify remains the authority on what is active; only who
 * creates it moves.
 */

/**
 * The store handle Shopify uses in admin URLs.
 *
 * `test-ankur-grxxuhm3.myshopify.com` -> `test-ankur-grxxuhm3`. Any other
 * shape is returned unchanged rather than guessed at; the caller has already
 * validated the domain through the strict allowlist.
 */
export function storeHandle(shopDomain: string): string {
  return shopDomain.replace(/\.myshopify\.com$/i, '');
}

/**
 * Where to send a merchant to choose or change their plan.
 *
 * This replaces the approval URL that `appSubscriptionCreate` used to return.
 * It is deliberately the same field on the wire (`confirmationUrl`) so the
 * admin UI — which just assigns it to `window.top.location` — needs no change
 * and cannot end up half-migrated.
 *
 * `appHandle` is the app's handle in the Partner dashboard (the segment in
 * `admin.shopify.com/store/<store>/apps/<handle>`), not the client id.
 */
export function pricingPlansUrl(shopDomain: string, appHandle: string): string {
  return `https://admin.shopify.com/store/${storeHandle(shopDomain)}/charges/${appHandle}/pricing_plans`;
}
