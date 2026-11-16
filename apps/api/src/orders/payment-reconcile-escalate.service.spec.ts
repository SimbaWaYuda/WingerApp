import {
  PaymentReconcileManualReviewReason,
  PaymentStatus,
} from '@prisma/client';
import {
  PAYMENT_RECONCILE_UNLEASEABLE_ESCALATE_AFTER_MS,
  PaymentReconcileEscalateService,
} from './payment-reconcile-escalate.service';
import { utcWallClockIso } from './payment-reconcile-utc';

type OrderRow = {
  id: string;
  paymentStatus: PaymentStatus;
  paymentMode: string;
  createdAt: Date;
  stripeChargeAttemptAt: Date | null;
  paymentReconcileManualReviewAt: Date | null;
  paymentReconcileManualReviewReason: PaymentReconcileManualReviewReason | null;
  paymentReconcileLeaseOwner: string | null;
  paymentReconcileLeaseExpiresAt: Date | null;
};

function sqlText(strings: TemplateStringsArray): string {
  return strings.join(' ');
}

function createMemoryPrisma(rows: Map<string, OrderRow>) {
  const lastArgs = { nowMs: 0, ageMs: PAYMENT_RECONCILE_UNLEASEABLE_ESCALATE_AFTER_MS, limit: 0 };

  const selectEligible = () => {
    const ageDeadline = lastArgs.nowMs - lastArgs.ageMs;
    return [...rows.values()]
      .filter((o) => {
        if (o.paymentStatus !== PaymentStatus.PENDING) return false;
        if (o.paymentMode !== 'test' && o.paymentMode !== 'live') return false;
        if (o.paymentReconcileManualReviewAt) return false;
        if (o.createdAt.getTime() > ageDeadline) return false;
        const missing = o.stripeChargeAttemptAt == null;
        const future =
          o.stripeChargeAttemptAt != null &&
          o.stripeChargeAttemptAt.getTime() > lastArgs.nowMs;
        if (!missing && !future) return false;
        const leaseActive =
          o.paymentReconcileLeaseOwner &&
          o.paymentReconcileLeaseExpiresAt &&
          o.paymentReconcileLeaseExpiresAt.getTime() > lastArgs.nowMs;
        if (leaseActive) return false;
        return true;
      })
      .sort((a, b) => {
        const c = a.createdAt.getTime() - b.createdAt.getTime();
        if (c !== 0) return c;
        return a.id.localeCompare(b.id);
      })
      .slice(0, lastArgs.limit)
      .map((o) => ({
        id: o.id,
        reason: o.stripeChargeAttemptAt
          ? PaymentReconcileManualReviewReason.INCONSISTENT_ATTEMPT_AT
          : PaymentReconcileManualReviewReason.MISSING_ATTEMPT_AT,
      }));
  };

  const handleQuery = async (
    strings: TemplateStringsArray,
    values: unknown[],
  ) => {
    const sql = sqlText(strings);
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      return selectEligible();
    }
    if (sql.includes('paymentReconcileManualReviewReason')) {
      // nowIso, reason, id
      const nowIso = values[0] as string;
      const reason = values[1] as PaymentReconcileManualReviewReason;
      const id = values[2] as string;
      const row = rows.get(id);
      if (!row || row.paymentStatus !== PaymentStatus.PENDING) return [];
      if (row.paymentReconcileManualReviewAt) return [];
      if (
        reason !== PaymentReconcileManualReviewReason.MISSING_ATTEMPT_AT &&
        reason !== PaymentReconcileManualReviewReason.INCONSISTENT_ATTEMPT_AT
      ) {
        return [];
      }
      row.paymentReconcileManualReviewAt = new Date(nowIso);
      row.paymentReconcileManualReviewReason = reason;
      row.paymentReconcileLeaseOwner = null;
      row.paymentReconcileLeaseExpiresAt = null;
      return [{ id }];
    }
    return [];
  };

  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
          handleQuery(strings, values),
        ),
      };
      return fn(tx);
    }),
  };

  return { prisma, rows, lastArgs };
}

describe('PaymentReconcileEscalateService', () => {
  const fixedNow = Date.UTC(2026, 10, 16, 18, 0, 0);
  const ageMs = PAYMENT_RECONCILE_UNLEASEABLE_ESCALATE_AFTER_MS;

  function seed(partial: Partial<OrderRow> & { id: string }): OrderRow {
    return {
      paymentStatus: PaymentStatus.PENDING,
      paymentMode: 'test',
      createdAt: new Date(fixedNow - ageMs - 1),
      stripeChargeAttemptAt: null,
      paymentReconcileManualReviewAt: null,
      paymentReconcileManualReviewReason: null,
      paymentReconcileLeaseOwner: null,
      paymentReconcileLeaseExpiresAt: null,
      ...partial,
    };
  }

  function build(list: OrderRow[]) {
    const rows = new Map(list.map((r) => [r.id, { ...r }]));
    const { prisma, lastArgs } = createMemoryPrisma(rows);
    const service = new PaymentReconcileEscalateService(prisma as never);
    const run = (batchSize = 50, nowMs = fixedNow) => {
      lastArgs.nowMs = nowMs;
      lastArgs.ageMs = ageMs;
      lastArgs.limit = batchSize;
      return service.escalateUnleaseableOrders({ batchSize, nowMs, ageMs });
    };
    return { service, rows, run };
  }

  it('classifies missing attemptAt as MISSING_ATTEMPT_AT', async () => {
    const { run, rows } = build([seed({ id: 'miss' })]);
    const result = await run();
    expect(result.escalated).toBe(1);
    expect(result.byReason.MISSING_ATTEMPT_AT).toBe(1);
    expect(result.byReason.INCONSISTENT_ATTEMPT_AT).toBe(0);
    expect(rows.get('miss')!.paymentReconcileManualReviewReason).toBe(
      PaymentReconcileManualReviewReason.MISSING_ATTEMPT_AT,
    );
    expect(rows.get('miss')!.paymentReconcileManualReviewAt?.toISOString()).toBe(
      utcWallClockIso(fixedNow),
    );
  });

  it('classifies future attemptAt as INCONSISTENT_ATTEMPT_AT', async () => {
    const { run, rows } = build([
      seed({
        id: 'fut',
        stripeChargeAttemptAt: new Date(fixedNow + 60_000),
      }),
    ]);
    const result = await run();
    expect(result.byReason.INCONSISTENT_ATTEMPT_AT).toBe(1);
    expect(rows.get('fut')!.paymentReconcileManualReviewReason).toBe(
      PaymentReconcileManualReviewReason.INCONSISTENT_ATTEMPT_AT,
    );
  });

  it('enforces exact 30-minute createdAt boundary', async () => {
    const at = build([
      seed({ id: 'at', createdAt: new Date(fixedNow - ageMs) }),
    ]);
    expect((await at.run()).escalated).toBe(1);

    const younger = build([
      seed({ id: 'young', createdAt: new Date(fixedNow - ageMs + 1) }),
    ]);
    expect((await younger.run()).escalated).toBe(0);

    const older = build([
      seed({ id: 'old', createdAt: new Date(fixedNow - ageMs - 1) }),
    ]);
    expect((await older.run()).escalated).toBe(1);
  });

  it('excludes COD, Lipa, demo and past-attempt leaseable orders', async () => {
    const { run } = build([
      seed({ id: 'cod', paymentMode: 'cod' }),
      seed({ id: 'lipa', paymentMode: 'lipa' }),
      seed({ id: 'demo', paymentMode: 'demo' }),
      seed({
        id: 'leaseable',
        stripeChargeAttemptAt: new Date(fixedNow - 10 * 60_000),
      }),
      seed({ id: 'ok' }),
    ]);
    const result = await run();
    expect(result.orderIds).toEqual(['ok']);
  });

  it('does not overwrite existing manual review', async () => {
    const { run, rows } = build([
      seed({
        id: 'done',
        paymentReconcileManualReviewAt: new Date(fixedNow - 1000),
        paymentReconcileManualReviewReason:
          PaymentReconcileManualReviewReason.SEARCH_AMBIGUOUS,
      }),
    ]);
    expect((await run()).escalated).toBe(0);
    expect(rows.get('done')!.paymentReconcileManualReviewReason).toBe(
      PaymentReconcileManualReviewReason.SEARCH_AMBIGUOUS,
    );
  });

  it('skips active lease; escalates expired lease', async () => {
    const active = build([
      seed({
        id: 'active',
        paymentReconcileLeaseOwner: 'tok',
        paymentReconcileLeaseExpiresAt: new Date(fixedNow + 30_000),
      }),
    ]);
    expect((await active.run()).escalated).toBe(0);

    const expired = build([
      seed({
        id: 'expired',
        paymentReconcileLeaseOwner: 'tok',
        paymentReconcileLeaseExpiresAt: new Date(fixedNow - 1),
      }),
    ]);
    const result = await expired.run();
    expect(result.escalated).toBe(1);
    expect(expired.rows.get('expired')!.paymentReconcileLeaseOwner).toBeNull();
  });

  it('writes timestamp and reason together; never writes reserved reasons', async () => {
    const queryRawCalls: { sql: string; values: unknown[] }[] = [];
    const prisma = {
      $transaction: async (fn: (tx: unknown) => unknown) => {
        const tx = {
          $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join(' ');
            queryRawCalls.push({ sql, values });
            if (sql.includes('FOR UPDATE SKIP LOCKED')) {
              return Promise.resolve([
                {
                  id: 'x',
                  reason: PaymentReconcileManualReviewReason.MISSING_ATTEMPT_AT,
                },
              ]);
            }
            return Promise.resolve([{ id: 'x' }]);
          },
        };
        return fn(tx);
      },
    };
    const service = new PaymentReconcileEscalateService(prisma as never);
    await service.escalateUnleaseableOrders({ batchSize: 1, nowMs: fixedNow });
    const update = queryRawCalls.find((c) =>
      c.sql.includes('SET'),
    );
    expect(update).toBeTruthy();
    expect(update!.sql).toContain('paymentReconcileManualReviewAt');
    expect(update!.sql).toContain('paymentReconcileManualReviewReason');
    expect(update!.values).toContain(
      PaymentReconcileManualReviewReason.MISSING_ATTEMPT_AT,
    );
    expect(update!.values).not.toContain(
      PaymentReconcileManualReviewReason.RETRY_EXHAUSTED,
    );
    expect(update!.values).not.toContain(
      PaymentReconcileManualReviewReason.IDENTITY_MISMATCH,
    );
    expect(update!.values).not.toContain(
      PaymentReconcileManualReviewReason.SEARCH_AMBIGUOUS,
    );
    expect(update!.values).not.toContain(
      PaymentReconcileManualReviewReason.SEARCH_UNRESOLVED,
    );
  });
});
