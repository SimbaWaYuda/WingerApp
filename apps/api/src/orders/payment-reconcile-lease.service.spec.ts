import { PaymentReconcileManualReviewReason, PaymentStatus } from '@prisma/client';
import {
  PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
  PAYMENT_RECONCILE_MAX_CLAIMS,
  PaymentReconcileLeaseService,
} from './payment-reconcile-lease.service';
import { utcWallClockIso } from './payment-reconcile-utc';

type OrderRow = {
  id: string;
  paymentStatus: PaymentStatus;
  paymentMode: string;
  stripePaymentIntentId: string | null;
  stripeChargeAttemptAt: Date | null;
  paymentReconcileLeaseOwner: string | null;
  paymentReconcileLeaseExpiresAt: Date | null;
  paymentReconcileAttemptCount: number;
  paymentReconcileNextAt: Date | null;
  paymentReconcileManualReviewAt: Date | null;
};

function eligibleRow(overrides: Partial<OrderRow> = {}): OrderRow {
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);
  return {
    id: 'ord-1',
    paymentStatus: PaymentStatus.PENDING,
    paymentMode: 'test',
    stripePaymentIntentId: 'pi_1',
    stripeChargeAttemptAt: new Date(now - 10 * 60 * 1000),
    paymentReconcileLeaseOwner: null,
    paymentReconcileLeaseExpiresAt: null,
    paymentReconcileAttemptCount: 0,
    paymentReconcileNextAt: null,
    paymentReconcileManualReviewAt: null,
    ...overrides,
  };
}

function sqlText(strings: TemplateStringsArray): string {
  return strings.join(' ');
}

function createMemoryPrisma(rows: Map<string, OrderRow>) {
  const lastClaimArgs = {
    nowMs: 0,
    graceMs: PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
    limit: 0,
  };

  const selectEligible = (nowMs: number, graceMs: number, limit: number) => {
    const graceDeadline = nowMs - graceMs;
    return [...rows.values()]
      .filter((o) => {
        if (o.paymentStatus !== PaymentStatus.PENDING) return false;
        if (o.paymentMode !== 'test' && o.paymentMode !== 'live') return false;
        if (o.paymentReconcileManualReviewAt) return false;
        if (
          o.paymentReconcileNextAt &&
          o.paymentReconcileNextAt.getTime() > nowMs
        ) {
          return false;
        }
        const leaseActive =
          o.paymentReconcileLeaseOwner &&
          o.paymentReconcileLeaseExpiresAt &&
          o.paymentReconcileLeaseExpiresAt.getTime() > nowMs;
        if (leaseActive) return false;
        if (!o.stripeChargeAttemptAt) return false;
        if (o.stripeChargeAttemptAt.getTime() > graceDeadline) return false;
        if (o.paymentReconcileAttemptCount >= PAYMENT_RECONCILE_MAX_CLAIMS) {
          return false;
        }
        // Bound-only literal prefix (S2.6.20.9d) — matches LEFT(id, 3) = 'pi_'.
        const pi = o.stripePaymentIntentId ?? '';
        if (pi.length < 3 || pi.slice(0, 3) !== 'pi_') return false;
        return true;
      })
      .sort((a, b) => {
        const aKey = (a.paymentReconcileNextAt ?? a.stripeChargeAttemptAt)!.getTime();
        const bKey = (b.paymentReconcileNextAt ?? b.stripeChargeAttemptAt)!.getTime();
        if (aKey !== bKey) return aKey - bKey;
        return a.id.localeCompare(b.id);
      })
      .slice(0, limit)
      .map((o) => ({ id: o.id }));
  };

  const handleQuery = async (
    strings: TemplateStringsArray,
    values: unknown[],
  ) => {
    const sql = sqlText(strings);
    if (sql.includes('FOR UPDATE SKIP LOCKED')) {
      return selectEligible(
        lastClaimArgs.nowMs,
        lastClaimArgs.graceMs,
        lastClaimArgs.limit,
      );
    }
    // Claim update: owner, expiresIso, id
    if (sql.includes('paymentReconcileAttemptCount') && sql.includes('UPDATE')) {
      const leaseOwner = values[0] as string;
      const expiresIso = values[1] as string;
      const id = values[2] as string;
      const row = rows.get(id);
      if (!row || row.paymentStatus !== PaymentStatus.PENDING) return [];
      if (row.paymentReconcileManualReviewAt) return [];
      row.paymentReconcileLeaseOwner = leaseOwner;
      row.paymentReconcileLeaseExpiresAt = new Date(expiresIso);
      row.paymentReconcileAttemptCount += 1;
      return [{ id }];
    }
    // renew: expiresIso, id, owner, nowIso
    if (
      sql.includes('SET "paymentReconcileLeaseExpiresAt"') &&
      !sql.includes('ManualReview')
    ) {
      const expiresIso = values[0] as string;
      const id = values[1] as string;
      const owner = values[2] as string;
      const nowIso = values[3] as string;
      const row = rows.get(id);
      const nowMs = Date.parse(nowIso);
      if (!row || row.paymentStatus !== PaymentStatus.PENDING) return [];
      if (row.paymentReconcileLeaseOwner !== owner) return [];
      if (
        !row.paymentReconcileLeaseExpiresAt ||
        row.paymentReconcileLeaseExpiresAt.getTime() <= nowMs
      ) {
        return [];
      }
      row.paymentReconcileLeaseExpiresAt = new Date(expiresIso);
      return [{ id }];
    }
    // schedule: nextIso, id, owner, nowIso
    if (sql.includes('SET "paymentReconcileNextAt"')) {
      const nextIso = values[0] as string;
      const id = values[1] as string;
      const owner = values[2] as string;
      const nowIso = values[3] as string;
      const row = rows.get(id);
      const nowMs = Date.parse(nowIso);
      if (!row || row.paymentStatus !== PaymentStatus.PENDING) return [];
      if (row.paymentReconcileLeaseOwner !== owner) return [];
      if (row.paymentReconcileManualReviewAt) return [];
      if (
        !row.paymentReconcileLeaseExpiresAt ||
        row.paymentReconcileLeaseExpiresAt.getTime() <= nowMs
      ) {
        return [];
      }
      row.paymentReconcileNextAt = new Date(nextIso);
      return [{ id }];
    }
    // manual review: nowIso, reason, id, owner, nowIso
    if (sql.includes('paymentReconcileManualReviewAt" =')) {
      const nowIso = values[0] as string;
      const id = values[2] as string;
      const owner = values[3] as string;
      const row = rows.get(id);
      const nowMs = Date.parse(nowIso);
      if (!row || row.paymentStatus !== PaymentStatus.PENDING) return [];
      if (row.paymentReconcileLeaseOwner !== owner) return [];
      if (row.paymentReconcileManualReviewAt) return [];
      if (
        !row.paymentReconcileLeaseExpiresAt ||
        row.paymentReconcileLeaseExpiresAt.getTime() <= nowMs
      ) {
        return [];
      }
      row.paymentReconcileManualReviewAt = new Date(nowIso);
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
        order: {
          findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
            const row = rows.get(where.id);
            return row ? { ...row } : null;
          }),
        },
      };
      return fn(tx);
    }),
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
      handleQuery(strings, values),
    ),
    order: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.get(where.id);
        return row ? { ...row } : null;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const row = rows.get(where.id as string);
          if (!row) return { count: 0 };
          if (
            where.paymentReconcileLeaseOwner != null &&
            row.paymentReconcileLeaseOwner !== where.paymentReconcileLeaseOwner
          ) {
            return { count: 0 };
          }
          for (const [k, v] of Object.entries(data)) {
            (row as Record<string, unknown>)[k] = v;
          }
          return { count: 1 };
        },
      ),
    },
  };

  return { prisma, rows, lastClaimArgs };
}

describe('utcWallClockIso', () => {
  it('emits ISO-8601 UTC suitable for ::timestamp binds', () => {
    const iso = utcWallClockIso(Date.UTC(2026, 10, 16, 12, 0, 0));
    expect(iso).toBe('2026-11-16T12:00:00.000Z');
    expect(iso.endsWith('Z')).toBe(true);
  });
});

describe('PaymentReconcileLeaseService', () => {
  const fixedNow = Date.UTC(2026, 10, 16, 12, 0, 0);

  function build(seed: OrderRow[]) {
    const rows = new Map(seed.map((r) => [r.id, { ...r }]));
    const { prisma, lastClaimArgs } = createMemoryPrisma(rows);
    const service = new PaymentReconcileLeaseService(prisma as never);
    const claim = (
      limit: number,
      nowMs = fixedNow,
      graceMs = PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
    ) => {
      lastClaimArgs.nowMs = nowMs;
      lastClaimArgs.graceMs = graceMs;
      lastClaimArgs.limit = limit;
      return service.claimEligibleBatch({
        limit,
        nowMs,
        graceMs,
        leaseTtlMs: 60_000,
      });
    };
    return { service, rows, claim };
  }

  it('claims an eligible PENDING card order with a unique token', async () => {
    const { claim, rows } = build([eligibleRow()]);
    const claimed = await claim(10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].leaseOwner).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(rows.get('ord-1')!.paymentReconcileAttemptCount).toBe(1);
    expect(rows.get('ord-1')!.paymentReconcileLeaseExpiresAt?.toISOString()).toBe(
      utcWallClockIso(fixedNow + 60_000),
    );
  });

  it('excludes COD, Lipa, terminal statuses and manual review', async () => {
    const { claim } = build([
      eligibleRow({ id: 'cod', paymentMode: 'cod' }),
      eligibleRow({ id: 'lipa', paymentMode: 'lipa' }),
      eligibleRow({ id: 'paid', paymentStatus: PaymentStatus.PAID }),
      eligibleRow({
        id: 'manual',
        paymentReconcileManualReviewAt: new Date(fixedNow - 1000),
      }),
      eligibleRow({ id: 'ok' }),
    ]);
    expect((await claim(10)).map((c) => c.id)).toEqual(['ok']);
  });

  it('literal pi_ prefix: claims only true pi_ ids (not LIKE wildcards)', async () => {
    const { claim, rows } = build([
      eligibleRow({ id: 'pi-123', stripePaymentIntentId: 'pi_123' }),
      eligibleRow({ id: 'pi-bare', stripePaymentIntentId: 'pi_' }),
      eligibleRow({ id: 'pixa', stripePaymentIntentId: 'pixa123' }),
      eligibleRow({ id: 'pix', stripePaymentIntentId: 'pix' }),
      eligibleRow({ id: 'pi-only', stripePaymentIntentId: 'pi' }),
      eligibleRow({ id: 'empty', stripePaymentIntentId: '' }),
      eligibleRow({ id: 'null-pi', stripePaymentIntentId: null }),
      eligibleRow({ id: 'ch', stripePaymentIntentId: 'ch_123' }),
    ]);
    const claimed = await claim(10);
    expect(claimed.map((c) => c.id).sort()).toEqual(['pi-123', 'pi-bare']);
    for (const id of ['pixa', 'pix', 'pi-only', 'empty', 'null-pi', 'ch']) {
      expect(rows.get(id)!.paymentReconcileAttemptCount).toBe(0);
      expect(rows.get(id)!.paymentReconcileLeaseOwner).toBeNull();
    }
  });

  it('excludes orders already at max claim attempts', async () => {
    const { claim } = build([
      eligibleRow({
        id: 'exhausted',
        paymentReconcileAttemptCount: PAYMENT_RECONCILE_MAX_CLAIMS,
      }),
      eligibleRow({
        id: 'ok',
        paymentReconcileAttemptCount: PAYMENT_RECONCILE_MAX_CLAIMS - 1,
      }),
    ]);
    expect((await claim(10)).map((c) => c.id)).toEqual(['ok']);
  });

  it('excludes future nextAt; includes due or null nextAt', async () => {
    const { claim } = build([
      eligibleRow({
        id: 'future',
        paymentReconcileNextAt: new Date(fixedNow + 60_000),
      }),
      eligibleRow({ id: 'null-next', paymentReconcileNextAt: null }),
      eligibleRow({
        id: 'due-next',
        paymentReconcileNextAt: new Date(fixedNow - 1),
      }),
    ]);
    expect((await claim(10)).map((c) => c.id).sort()).toEqual([
      'due-next',
      'null-next',
    ]);
  });

  it('does not steal an active lease; reclaims expired and exactly-at-now leases', async () => {
    const active = build([
      eligibleRow({
        paymentReconcileLeaseOwner: 'worker-a',
        paymentReconcileLeaseExpiresAt: new Date(fixedNow + 30_000),
      }),
    ]);
    expect(await active.claim(10)).toHaveLength(0);

    const expired = build([
      eligibleRow({
        paymentReconcileLeaseOwner: 'old-token',
        paymentReconcileLeaseExpiresAt: new Date(fixedNow - 1),
        paymentReconcileAttemptCount: 2,
      }),
    ]);
    const claimed = await expired.claim(10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].leaseOwner).not.toBe('old-token');
    expect(expired.rows.get('ord-1')!.paymentReconcileAttemptCount).toBe(3);

    // Equality is reclaimable: complement of live-lease `expiresAt > now`.
    const atBoundary = build([
      eligibleRow({
        id: 'ord-eq',
        paymentReconcileLeaseOwner: 'eq-token',
        paymentReconcileLeaseExpiresAt: new Date(fixedNow),
        paymentReconcileAttemptCount: 1,
      }),
    ]);
    const eqClaimed = await atBoundary.claim(10);
    expect(eqClaimed).toHaveLength(1);
    expect(eqClaimed[0].leaseOwner).not.toBe('eq-token');
    expect(atBoundary.rows.get('ord-eq')!.paymentReconcileAttemptCount).toBe(2);
  });

  it('claim SELECT uses <= for lease expiry reclaim (complement of expiresAt > now)', async () => {
    const queryRawCalls: TemplateStringsArray[] = [];
    const fakeTx = {
      $queryRaw: jest.fn((strings: TemplateStringsArray) => {
        queryRawCalls.push(strings);
        return Promise.resolve([]);
      }),
      order: { findUnique: jest.fn() },
    };
    const capturingPrisma = {
      $transaction: async (fn: (tx: unknown) => unknown) => fn(fakeTx),
    };
    const capturing = new PaymentReconcileLeaseService(capturingPrisma as never);
    await capturing.claimEligibleBatch({
      limit: 1,
      nowMs: fixedNow,
      graceMs: PAYMENT_RECONCILE_DEFAULT_GRACE_MS,
      leaseTtlMs: 60_000,
    });
    const selectSql = queryRawCalls[0].join(' ');
    expect(selectSql).toMatch(/"paymentReconcileLeaseExpiresAt"\s*<=/);
    expect(selectSql).not.toMatch(/"paymentReconcileLeaseExpiresAt"\s*<(?!=)/);
    expect(selectSql).toContain('"paymentStatus" = \'PENDING\'');
    expect(selectSql).toContain('"paymentReconcileManualReviewAt" IS NULL');
    expect(selectSql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('respects batch limit and grace / missing attemptAt', async () => {
    const { claim } = build([
      eligibleRow({
        id: 'a',
        stripeChargeAttemptAt: new Date(fixedNow - 20 * 60_000),
      }),
      eligibleRow({
        id: 'b',
        stripeChargeAttemptAt: new Date(fixedNow - 15 * 60_000),
      }),
      eligibleRow({
        id: 'c',
        stripeChargeAttemptAt: new Date(fixedNow - 10 * 60_000),
      }),
      eligibleRow({ id: 'missing', stripeChargeAttemptAt: null }),
      eligibleRow({
        id: 'grace',
        stripeChargeAttemptAt: new Date(
          fixedNow - PAYMENT_RECONCILE_DEFAULT_GRACE_MS + 1_000,
        ),
      }),
    ]);
    expect((await claim(2)).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('wrong or expired token cannot renew or schedule; failed updates return false', async () => {
    const { service, claim, rows } = build([eligibleRow()]);
    const [held] = await claim(1);
    expect(
      await service.renewLease({
        orderId: 'ord-1',
        leaseOwner: 'wrong',
        nowMs: fixedNow,
      }),
    ).toBe(false);
    expect(
      await service.scheduleNextAttempt({
        orderId: 'ord-1',
        leaseOwner: 'wrong',
        nextAt: new Date(fixedNow + 60_000),
        nowMs: fixedNow,
      }),
    ).toBe(false);
    rows.get('ord-1')!.paymentReconcileLeaseExpiresAt = new Date(fixedNow - 1);
    expect(
      await service.renewLease({
        orderId: 'ord-1',
        leaseOwner: held.leaseOwner,
        nowMs: fixedNow,
      }),
    ).toBe(false);
    expect(rows.get('ord-1')!.paymentReconcileLeaseOwner).toBe(held.leaseOwner);
  });

  it('owner can renew, schedule, mark manual review; release works after terminal', async () => {
    const { service, claim, rows } = build([eligibleRow()]);
    const [held] = await claim(1);
    expect(await service.isLeaseHeld('ord-1', held.leaseOwner, fixedNow + 1)).toBe(
      true,
    );
    expect(
      await service.renewLease({
        orderId: 'ord-1',
        leaseOwner: held.leaseOwner,
        nowMs: fixedNow + 1_000,
        leaseTtlMs: 120_000,
      }),
    ).toBe(true);
    expect(
      await service.scheduleNextAttempt({
        orderId: 'ord-1',
        leaseOwner: held.leaseOwner,
        nextAt: new Date(fixedNow + 300_000),
        nowMs: fixedNow + 1_000,
      }),
    ).toBe(true);
    expect(rows.get('ord-1')!.paymentReconcileNextAt?.toISOString()).toBe(
      utcWallClockIso(fixedNow + 300_000),
    );
    expect(
      await service.markManualReview({
        orderId: 'ord-1',
        leaseOwner: held.leaseOwner,
        reason: PaymentReconcileManualReviewReason.RETRY_EXHAUSTED,
        nowMs: fixedNow + 1_000,
      }),
    ).toBe(true);
    expect(rows.get('ord-1')!.paymentReconcileLeaseOwner).toBeNull();

    const again = build([eligibleRow({ id: 'ord-2' })]);
    const [held2] = await again.claim(1);
    again.rows.get('ord-2')!.paymentStatus = PaymentStatus.PAID;
    expect(
      await again.service.scheduleNextAttempt({
        orderId: 'ord-2',
        leaseOwner: held2.leaseOwner,
        nextAt: new Date(fixedNow + 60_000),
        nowMs: fixedNow,
      }),
    ).toBe(false);
    expect(await again.service.releaseLease('ord-2', held2.leaseOwner)).toBe(true);
  });
});
