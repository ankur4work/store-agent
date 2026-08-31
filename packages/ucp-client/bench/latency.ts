/**
 * Phase 0 latency harness.
 *
 * Measures client-side overhead per UCP tool and, critically, the cost of the
 * SafeCart read-modify-write round trip versus a naive single write — because
 * safety costs us an extra network hop and we need that number before Phase 1
 * commits to a latency budget.
 *
 * Run against the mock (default) for overhead isolation:
 *   npm run bench --workspace @storeagent/ucp-client
 *
 * Run against a real store by setting SHOP_DOMAIN + AGENT_PROFILE:
 *   SHOP_DOMAIN=acme.myshopify.com AGENT_PROFILE=https://... npm run bench -w @storeagent/ucp-client
 */
import { UcpClient } from '../src/client.js';
import { SafeCart } from '../src/cart.js';
import { UcpTransport } from '../src/transport.js';
import { MockUcpServer } from '../test/mock-server.js';
import { HOSTILE_CART } from '../test/fixtures.js';

const ITERATIONS = Number(process.env['ITERATIONS'] ?? 300);
const WARMUP = 30;
const SIMULATED_RTT_MS = Number(process.env['SIMULATED_RTT_MS'] ?? 0);

const shopDomain = process.env['SHOP_DOMAIN'];
const agentProfile = process.env['AGENT_PROFILE'] ?? 'https://storeagent.dev/ucp-profile.json';
const live = Boolean(shopDomain);

const server = new MockUcpServer(SIMULATED_RTT_MS ? { latencyMs: SIMULATED_RTT_MS } : {});
const transport = live
  ? new UcpTransport({ shopDomain: shopDomain!, agentProfile })
  : new UcpTransport({
      shopDomain: 'mock.test',
      agentProfile,
      fetch: server.fetch,
      endpoint: server.endpoint,
    });

const client = new UcpClient(transport);
const safeCart = new SafeCart(client);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i]!;
}

async function measure(label: string, budgetMs: number, fn: () => Promise<unknown>): Promise<boolean> {
  for (let i = 0; i < WARMUP; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);
  const pass = p95 <= budgetMs;
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(
    `${mark.padEnd(5)} ${label.padEnd(34)} p50 ${p50.toFixed(2).padStart(8)}ms   ` +
      `p95 ${p95.toFixed(2).padStart(8)}ms   p99 ${p99.toFixed(2).padStart(8)}ms   (budget p95 ${budgetMs}ms)`,
  );
  return pass;
}

async function main(): Promise<void> {
  console.log(
    `\nUCP latency harness — ${live ? `LIVE ${shopDomain}` : 'MOCK'}` +
      `${SIMULATED_RTT_MS ? ` +${SIMULATED_RTT_MS}ms simulated RTT` : ''}` +
      `  ·  ${ITERATIONS} iterations\n`,
  );

  const { cart } = await client.createCart(HOSTILE_CART);
  const results: boolean[] = [];

  results.push(await measure('search_catalog', 5 + SIMULATED_RTT_MS * 1.5, () => client.searchCatalog({ query: 'wool' })));
  results.push(
    await measure('lookup_catalog (10 ids)', 5 + SIMULATED_RTT_MS * 1.5, () =>
      client.lookupCatalog({ ids: ['gid://shopify/Product/1', 'gid://shopify/Product/2'] }),
    ),
  );
  results.push(
    await measure('get_product', 5 + SIMULATED_RTT_MS * 1.5, () =>
      client.getProduct({ id: 'gid://shopify/Product/1' }),
    ),
  );
  results.push(await measure('get_cart', 5 + SIMULATED_RTT_MS * 1.5, () => client.getCart(cart.id)));

  // The number that actually matters: SafeCart costs one extra round trip.
  results.push(
    await measure('SafeCart.addLine (read+write)', 10 + SIMULATED_RTT_MS * 2.5, () =>
      safeCart.addLine(cart.id, { variant_id: 'v-scarf-grey', quantity: 1 }),
    ),
  );
  results.push(
    await measure('naive updateCart (write only)', 5 + SIMULATED_RTT_MS * 1.5, () =>
      client.updateCart(cart.id, { ...HOSTILE_CART }),
    ),
  );

  const failed = results.filter((r) => !r).length;
  console.log(
    `\n${failed === 0 ? 'ALL BUDGETS MET' : `${failed} BUDGET(S) EXCEEDED`}` +
      `\nNote: SafeCart's extra hop is the price of not destroying carts. Phase 1` +
      `\nabsorbs it by caching get_cart in the session, so the write path is 1 RTT.\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

void main();
