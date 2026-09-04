# Postgres — going multi-node

SQLite is a single writer, which pins the deployment to one instance. This is
the path off that constraint. **You do not need it until one node is no longer
enough** — see `DEPLOY.md §5` for when that is.

---

## What this buys, and what it costs

Two nodes on one SQLite file do worse than error: they disagree about holdout
assignment and **silently corrupt the incrementality experiment**. So the
current deployment is correct only because it is pinned to one instance.

Postgres removes the pin, which unlocks zero-downtime deploys (two nodes must
overlap briefly), horizontal scale, and managed backups with PITR. It costs a
database to operate and one runtime dependency.

## The driver is yours to choose

`packages/gateway/src/store/postgres.ts` is written against a two-method
`SqlClient` interface, not against a driver:

```ts
export interface SqlClient {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}
```

The repo has **zero runtime dependencies** and this does not change that. Add
one at deploy time:

```bash
npm install pg
```

```ts
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // A gateway node holds a connection per in-flight turn. Size this against
  // Postgres's max_connections divided by node count, and put PgBouncer in
  // front before you get close.
  max: 20,
});

const sql = { query: (text, params) => pool.query(text, params) };
await migrate(sql);
const stores = createPostgresStores(sql);
```

Then pass those stores to `createGateway` exactly as the SQLite ones are today.
Every store interface is unchanged — this is an implementation swap, not a
refactor of call sites.

## Verification status

**The SQL is genuinely tested.** `packages/gateway/test/postgres.test.ts` runs
31 tests against real PostgreSQL 18.3 (PGlite, compiled to WASM). `ON CONFLICT`,
`RETURNING`, `JSONB`, `GREATEST` and the type coercions are executed, not
merely typechecked.

**Concurrency is not tested.** PGlite is single-connection, so multi-node
contention remains unproven. The queries are written so correctness does not
depend on interleaving — every mutation is one atomic statement, with no
read-modify-write round trips — but that is an argument, not a demonstration.
Two nodes against one real Postgres is still an untested configuration, and
the first time you run it is a test.

The two places where a race would actually hurt, and how each is handled:

| Race | Handling |
|---|---|
| Two nodes assign different holdout arms to one session | `ON CONFLICT DO NOTHING` — first write wins, arm can never flip |
| Two nodes process the same order webhook | Primary key on `(shop, order_id)`; retries update, never duplicate |
| Two nodes consume the same OAuth nonce | `DELETE … RETURNING` in one statement; exactly one racer gets a row |

## Spend ceilings are eventually consistent, deliberately

`SpendStore` is synchronous because it sits on the request path. `PgSpendStore`
therefore keeps a write-through cache: reads are local, writes go to Postgres
in the background, and `refresh()` pulls other nodes' totals in.

**With N nodes the daily ceiling can be overshot by up to one in-flight window
per node.** That is acceptable for a *ceiling* — a backstop against runaway
cost, not an accounting boundary — and unlike the holdout arm, an overshoot
costs a little money rather than correctness. Call `refresh()` on the same
interval as the existing sweeper.

Billing quotas are different: they must be exact, so they go to Postgres
directly rather than through a cache.

## Row-level security

`ARCHITECTURE §8` calls for RLS keyed on merchant, so that "no cross-tenant
query is expressible". Every table carries `shop` and every query filters on
it, but RLS needs roles and so belongs to the deployment:

```sql
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
  USING (shop = current_setting('storeagent.shop', true));
```

Repeat per table, and set `storeagent.shop` per transaction. Worth doing before
the first enterprise security review, not before the first merchant.

## Migration from SQLite

There is no automated migration, deliberately: with a handful of installed
shops the honest answer is to have merchants reinstall (which re-runs OAuth
and takes them seconds) rather than trust an untested data migration with
access tokens.

What cannot be recreated by reinstalling is **attribution history** — the
experiment. If any shop has a running experiment, export `exposures`,
`carts` and `conversions` and load them into Postgres before cutting over. The
schemas are deliberately identical in shape, so a `.dump`-and-load works with
only the boolean and `AUTOINCREMENT` syntax differing.

Do not run both databases at once. Two writers is the exact failure this whole
document exists to avoid.
