import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { PlanId, SubscriptionStatus, UsageStore } from '@storeagent/billing';
import { isPlanId } from '@storeagent/billing';

const nodeRequire = createRequire(import.meta.url);
void nodeRequire; // see store/sqlite.ts — types only, loaded there

/**
 * Billing state and usage counters.
 *
 * Persisted for the same reason the spend ceilings are: a counter that resets
 * on restart is a counter that can be reset by crashing. Here the consequence
 * is worse than lost budget — an un-counted conversation is revenue we never
 * bill, and a double-counted one is a merchant charged twice.
 *
 * The `resolved` table stores one row per (shop, period, session) with the
 * session id in the primary key. That is what makes counting idempotent: the
 * insert either succeeds once or conflicts, so no amount of retrying can bill
 * one conversation twice.
 */

export interface SubscriptionRecord {
  readonly shop: string;
  readonly subscriptionId: string | undefined;
  readonly planId: PlanId;
  readonly status: SubscriptionStatus;
  readonly test: boolean;
  readonly periodEnd: number | undefined;
  readonly trialEndsAt: number | undefined;
  readonly usageLineItemId: string | undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscriptions (
  shop               TEXT PRIMARY KEY,
  subscription_id    TEXT,
  plan_id            TEXT NOT NULL DEFAULT 'free',
  status             TEXT NOT NULL DEFAULT 'none',
  test               INTEGER NOT NULL DEFAULT 1,
  period_end         INTEGER,
  trial_ends_at      INTEGER,
  usage_line_item_id TEXT,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS resolved (
  shop       TEXT NOT NULL,
  period     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (shop, period, session_id)
);
CREATE INDEX IF NOT EXISTS resolved_shop_period ON resolved(shop, period);

CREATE TABLE IF NOT EXISTS overage (
  shop   TEXT NOT NULL,
  period TEXT NOT NULL,
  minor  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop, period)
);
`;

export class SqliteBillingStore implements UsageStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(SCHEMA);
  }

  // --- subscription ------------------------------------------------------

  get(shop: string): SubscriptionRecord {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE shop = ?').get(shop) as
      | Record<string, unknown>
      | undefined;

    if (row === undefined) {
      // No record means the free plan. Absence of a subscription IS the free
      // plan — we never create a zero-value subscription just to have a row.
      return {
        shop,
        subscriptionId: undefined,
        planId: 'free',
        status: 'none',
        test: true,
        periodEnd: undefined,
        trialEndsAt: undefined,
        usageLineItemId: undefined,
      };
    }

    const planId = String(row['plan_id']);
    return {
      shop,
      ...optional('subscriptionId', row['subscription_id']),
      // An unrecognised plan id falls back to free rather than guessing at
      // entitlement nobody paid for.
      planId: isPlanId(planId) ? planId : 'free',
      status: String(row['status']) as SubscriptionStatus,
      test: Number(row['test']) === 1,
      ...optionalNumber('periodEnd', row['period_end']),
      ...optionalNumber('trialEndsAt', row['trial_ends_at']),
      ...optional('usageLineItemId', row['usage_line_item_id']),
    } as SubscriptionRecord;
  }

  put(record: SubscriptionRecord): void {
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (shop, subscription_id, plan_id, status, test, period_end, trial_ends_at,
            usage_line_item_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(shop) DO UPDATE SET
           subscription_id = excluded.subscription_id, plan_id = excluded.plan_id,
           status = excluded.status, test = excluded.test,
           period_end = excluded.period_end, trial_ends_at = excluded.trial_ends_at,
           usage_line_item_id = excluded.usage_line_item_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.shop,
        record.subscriptionId ?? null,
        record.planId,
        record.status,
        record.test ? 1 : 0,
        record.periodEnd ?? null,
        record.trialEndsAt ?? null,
        record.usageLineItemId ?? null,
        Date.now(),
      );
  }

  /** Uninstall and GDPR redaction. Usage history goes too. */
  purge(shop: string): void {
    for (const t of ['subscriptions', 'resolved', 'overage']) {
      this.db.prepare(`DELETE FROM ${t} WHERE shop = ?`).run(shop);
    }
  }

  // --- UsageStore --------------------------------------------------------

  markResolved(shop: string, period: string, sessionId: string): boolean {
    // The primary key does the deduplication, so concurrent turns in the same
    // session cannot both count. `changes` is 0 when the row already existed.
    const result = this.db
      .prepare(
        `INSERT INTO resolved (shop, period, session_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(shop, period, session_id) DO NOTHING`,
      )
      .run(shop, period, sessionId, Date.now());
    return Number(result.changes) > 0;
  }

  resolvedCount(shop: string, period: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM resolved WHERE shop = ? AND period = ?')
      .get(shop, period) as { n: number };
    return Number(row.n);
  }

  addOverage(shop: string, period: string, minor: number): number {
    const row = this.db
      .prepare(
        `INSERT INTO overage (shop, period, minor) VALUES (?, ?, ?)
         ON CONFLICT(shop, period) DO UPDATE SET minor = overage.minor + excluded.minor
         RETURNING minor`,
      )
      .get(shop, period, minor) as { minor: number } | undefined;
    return Number(row?.minor ?? minor);
  }

  overageCharged(shop: string, period: string): number {
    const row = this.db
      .prepare('SELECT minor FROM overage WHERE shop = ? AND period = ?')
      .get(shop, period) as { minor: number } | undefined;
    return Number(row?.minor ?? 0);
  }

  /** Per-period history for the admin page. */
  history(shop: string, limit = 6): { period: string; resolved: number; overageMinor: number }[] {
    return (
      this.db
        .prepare(
          `SELECT r.period AS period, COUNT(*) AS resolved,
                  COALESCE((SELECT minor FROM overage o
                             WHERE o.shop = r.shop AND o.period = r.period), 0) AS overage
             FROM resolved r
            WHERE r.shop = ?
            GROUP BY r.period
            ORDER BY r.period DESC
            LIMIT ?`,
        )
        .all(shop, limit) as { period: string; resolved: number; overage: number }[]
    ).map((row) => ({
      period: String(row.period),
      resolved: Number(row.resolved),
      overageMinor: Number(row.overage),
    }));
  }
}

/** `exactOptionalPropertyTypes`: omit the key rather than assigning undefined. */
function optional(key: string, value: unknown): Record<string, string> {
  return value === null || value === undefined ? {} : { [key]: String(value) };
}

function optionalNumber(key: string, value: unknown): Record<string, number> {
  return value === null || value === undefined ? {} : { [key]: Number(value) };
}
