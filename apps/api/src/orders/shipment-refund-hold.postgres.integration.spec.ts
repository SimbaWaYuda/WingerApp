/**
 * S2.3 PostgreSQL concurrency tests.
 *
 * Default: migration is unapplied → concurrency suite is skipped (not a false pass).
 * To execute for real (separate approval required to apply migration):
 *   S23_PG_LOCK_TESTS=1 DATABASE_URL=postgresql://...@localhost:5433/winger
 *
 * Does NOT apply migrations. Does NOT call Stripe.
 */
import 'dotenv/config';
import {
  CommissionRecognitionStatus,
  PrismaClient,
  RefundAttemptStatus,
  RefundReconciliationResult,
  RefundSubmissionOutcome,
  ReturnRefundDrive,
  ReturnRefundStatus,
  ReturnRequestStatus,
  ShipmentRefundHoldStatus,
  UserRole,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { RefundAttemptService } from './refund-attempt.service';
import { operationKeyForReturn } from './refund-attempt.types';
import { ShipmentRefundHoldService } from './shipment-refund-hold.service';

jest.setTimeout(120000);

const run = `s23${Date.now().toString(36)}`;
const lockTestsRequested = process.env.S23_PG_LOCK_TESTS === '1';

function assertLocalDatabase(raw: string) {
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '');
  if (
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.port !== '5433' ||
    name !== 'winger'
  ) {
    throw new Error(`Refusing database ${url.hostname}:${url.port}/${name}`);
  }
}

function sessionUrl(raw: string, name: string) {
  const url = new URL(raw);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', name);
  return url.toString();
}

async function schemaReady(db: PrismaClient): Promise<boolean> {
  try {
    await db.$queryRaw`SELECT 1 FROM "ShipmentRefundHold" LIMIT 0`;
    await db.$queryRaw`SELECT 1 FROM "ShipmentRefundHoldLegacyEvidence" LIMIT 0`;
    await db.$queryRaw`SELECT "refundDrive" FROM "ReturnRequest" LIMIT 0`;
    return true;
  } catch {
    return false;
  }
}

function dollarsToCentsExact(amount: number): number {
  return Math.round(Number(amount) * 100);
}

describe('S2.3 PostgreSQL gate (always runs)', () => {
  it('does not claim concurrency proof while migration is unapplied / tests not opted in', async () => {
    const raw = process.env.DATABASE_URL ?? '';
    if (!raw) {
      expect(lockTestsRequested).toBe(false);
      return;
    }
    assertLocalDatabase(raw);
    const db = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s23-gate') } },
    });
    try {
      await db.$connect();
      const ready = await schemaReady(db);
      if (!lockTestsRequested) {
        // Opt-in not set: suite below is skipped; this documents the gate.
        expect(lockTestsRequested).toBe(false);
        return;
      }
      // Opt-in requires a migrated schema; fail closed if missing.
      expect(ready).toBe(true);
    } finally {
      await db.$disconnect();
    }
  });
});

const concurrencyDescribe = lockTestsRequested ? describe : describe.skip;

concurrencyDescribe('PostgreSQL ShipmentRefundHold concurrency (S2.3)', () => {
  let sessionA: PrismaClient;
  let sessionB: PrismaClient;
  /** Third session used only to hold a gate lock so A/B can block deterministically. */
  let sessionGate: PrismaClient;
  /**
   * Fourth session used exclusively for lock-probe queries.
   * Must never race or hold the gate — otherwise connection_limit=1 on A/B deadlocks the probe.
   */
  let sessionObserver: PrismaClient;
  let supplierId = '';
  let customerId = '';
  let adminId = '';
  const actor: AuthUser = {
    sub: '',
    email: 'admin@s23.invalid',
    role: UserRole.ADMIN,
    name: 'S23 admin',
  };

  beforeAll(async () => {
    const raw = process.env.DATABASE_URL ?? '';
    assertLocalDatabase(raw);
    sessionA = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s23-a') } },
    });
    sessionB = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s23-b') } },
    });
    sessionGate = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s23-gate-lock') } },
    });
    sessionObserver = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s23-observer') } },
    });
    await Promise.all([
      sessionA.$connect(),
      sessionB.$connect(),
      sessionGate.$connect(),
      sessionObserver.$connect(),
    ]);
    const ready = await schemaReady(sessionA);
    if (!ready) {
      throw new Error(
        'S23_PG_LOCK_TESTS=1 requires applied migration 20261115112027_shipment_refund_hold',
      );
    }

    adminId = `${run}-admin`;
    customerId = `${run}-customer`;
    supplierId = `${run}-supplier`;
    actor.sub = adminId;
    await sessionA.user.create({
      data: {
        id: adminId,
        email: `${run}-admin@s23.invalid`,
        passwordHash: 'fixture',
        name: 'S23 admin',
        role: UserRole.ADMIN,
      },
    });
    await sessionA.user.create({
      data: {
        id: customerId,
        email: `${run}-customer@s23.invalid`,
        passwordHash: 'fixture',
        name: 'S23 customer',
        role: UserRole.CUSTOMER,
      },
    });
    await sessionA.supplier.create({
      data: { id: supplierId, name: 'S23 Supplier' },
    });
  });

  afterAll(async () => {
    try {
      if (!sessionA) return;
      // Dependents first; only rows owned by this run's supplier/customer/product ids.
      await sessionA.refundAttemptSubmission.deleteMany({
        where: { refundAttempt: { supplierId } },
      });
      await sessionA.shipmentRefundHoldLegacyEvidence.deleteMany({
        where: { shipmentRefundHold: { supplierId } },
      });
      await sessionA.shipmentRefundHold.deleteMany({ where: { supplierId } });
      await sessionA.refundAttempt.deleteMany({ where: { supplierId } });
      // Commission clawback reservation → snapshot → then returns/items.
      await sessionA.commissionClawback.deleteMany({
        where: { returnRequest: { customerId } },
      });
      await sessionA.orderItemCommission.deleteMany({
        where: { orderItem: { supplierId } },
      });
      await sessionA.returnRequest.deleteMany({ where: { customerId } });
      await sessionA.orderShipment.deleteMany({ where: { supplierId } });
      await sessionA.orderItem.deleteMany({ where: { supplierId } });
      await sessionA.order.deleteMany({ where: { customerId } });
      await sessionA.product.deleteMany({
        where: { id: `${run}-prod`, supplierId },
      });
      await sessionA.supplier.deleteMany({ where: { id: supplierId } });
      await sessionA.user.deleteMany({
        where: { id: { in: [adminId, customerId] } },
      });
    } finally {
      await Promise.all([
        sessionA?.$disconnect(),
        sessionB?.$disconnect(),
        sessionGate?.$disconnect(),
        sessionObserver?.$disconnect(),
      ]);
    }
  });

  type ClawbackFn = (
    ...args: unknown[]
  ) => Promise<{ legacy: boolean; applied: boolean }>;

  function createClawbackTracker() {
    const mock = jest.fn(async () => ({ legacy: false, applied: true }));
    return {
      fn: mock as unknown as ClawbackFn,
      mock,
      get calls() {
        return mock.mock.calls.length;
      },
    };
  }

  function holds(db: PrismaClient, clawback?: ClawbackFn) {
    const applyReturnClawback =
      clawback ?? (async () => ({ legacy: false, applied: true }));
    return new ShipmentRefundHoldService(
      db as never,
      {
        applyReturnClawback,
      } as never,
    );
  }

  function attempts(
    db: PrismaClient,
    opts?: {
      clawback?: ClawbackFn;
      createRefundForAttempt?: jest.Mock;
      listRefundsForPaymentIntent?: jest.Mock;
    },
  ) {
    const holdSvc = holds(db, opts?.clawback);
    return new RefundAttemptService(
      db as never,
      {
        listRefundsForPaymentIntent:
          opts?.listRefundsForPaymentIntent ?? jest.fn(),
        createRefundForAttempt: opts?.createRefundForAttempt ?? jest.fn(),
      } as never,
      {
        applyReturnClawback:
          opts?.clawback ?? (async () => ({ legacy: false, applied: true })),
      } as never,
      holdSvc,
    );
  }

  /**
   * Hard capacity invariant (integer cents):
   * refundedAmount + SUM(RESERVED.amountCents) <= shipment payment total cents.
   * CONSUMED is reflected in refundedAmount; RELEASED reserves nothing.
   */
  async function assertShipmentCapacityInvariantCents(
    db: PrismaClient,
    orderShipmentId: string,
    paymentTotalCents: number,
  ) {
    const ship = await db.orderShipment.findUniqueOrThrow({
      where: { id: orderShipmentId },
    });
    const reserved = await db.shipmentRefundHold.aggregate({
      where: {
        orderShipmentId,
        status: ShipmentRefundHoldStatus.RESERVED,
      },
      _sum: { amountCents: true },
    });
    const refundedCents = dollarsToCentsExact(Number(ship.refundedAmount));
    const reservedCents = reserved._sum.amountCents ?? 0;
    expect(refundedCents + reservedCents).toBeLessThanOrEqual(
      paymentTotalCents,
    );
  }

  type GatedRelation = 'RefundAttempt' | 'ReturnRequest' | 'OrderShipment';

  type BlockedRacerRow = {
    pid: number;
    application_name: string | null;
    blockers: number[];
    waiting_relations: string[] | null;
  };

  async function snapshotRacerLockDiagnostics(gatePid: number) {
    // Observer-only: never poll via A/B (may be blocked) or Gate (holds lock).
    return sessionObserver.$queryRaw<
      Array<{
        pid: number;
        application_name: string | null;
        state: string | null;
        wait_event_type: string | null;
        wait_event: string | null;
        blockers: number[];
        lock_summary: string | null;
        observer_pid: number;
      }>
    >`
      SELECT
        a.pid,
        a.application_name,
        a.state,
        a.wait_event_type,
        a.wait_event,
        COALESCE(pg_blocking_pids(a.pid), ARRAY[]::int[]) AS blockers,
        (
          SELECT string_agg(
            DISTINCT concat_ws(
              ':',
              COALESCE(c.relname, l.locktype),
              l.mode,
              CASE WHEN l.granted THEN 'granted' ELSE 'waiting' END
            ),
            ', '
          )
          FROM pg_locks l
          LEFT JOIN pg_class c ON c.oid = l.relation
          WHERE l.pid = a.pid
        ) AS lock_summary,
        pg_backend_pid()::int AS observer_pid
      FROM pg_stat_activity a
      WHERE a.application_name IN (
          'winger-s23-a',
          'winger-s23-b',
          'winger-s23-gate-lock',
          'winger-s23-observer'
        )
         OR a.pid = ${gatePid}
      ORDER BY a.application_name NULLS LAST, a.pid
    `;
  }

  /**
   * Build the gated contention set from observer snapshots.
   * A racer is included iff it is directly blocked by gatePid, or blocked by
   * another racer already in the set (transitive queue that roots at the gate).
   * Only winger-s23-a / winger-s23-b PIDs count; gate and observer never do.
   */
  function resolveGatedContentionChain(
    racers: BlockedRacerRow[],
    gatePid: number,
  ): BlockedRacerRow[] {
    const byPid = new Map<number, BlockedRacerRow>();
    for (const row of racers) {
      const pid = Number(row.pid);
      if (!Number.isFinite(pid) || pid === gatePid) continue;
      if (
        row.application_name !== 'winger-s23-a' &&
        row.application_name !== 'winger-s23-b'
      ) {
        continue;
      }
      byPid.set(pid, {
        ...row,
        pid,
        blockers: (row.blockers ?? []).map((b) => Number(b)),
      });
    }

    const inChain = new Set<number>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [pid, row] of byPid) {
        if (inChain.has(pid)) continue;
        const blockers = row.blockers;
        const blockedByGate = blockers.includes(gatePid);
        const blockedByChainedRacer = blockers.some((b) => inChain.has(b));
        if (blockedByGate || blockedByChainedRacer) {
          inChain.add(pid);
          grew = true;
        }
      }
    }

    return [...inChain].map((pid) => byPid.get(pid)!);
  }

  /**
   * Wait until `minDistinctRacers` distinct A/B backends are in the gated
   * contention chain (direct or transitive via pg_blocking_pids). Prefer
   * waiters whose ungranted locks touch the gated relation when visible.
   * Polls exclusively through sessionObserver.
   */
  type ContentionProbeSuccess = {
    gatePid: number;
    gatedRelation: GatedRelation;
    observedChainRacerPids: number[];
    relationMatchedRacerPids: number[];
    usedRelationMatch: boolean;
    racerBlockers: Array<{
      pid: number;
      application_name: string | null;
      blockers: number[];
    }>;
  };

  async function waitUntilRacersBlockedByGate(params: {
    gatePid: number;
    gatedRelation: GatedRelation;
    minDistinctRacers: number;
    timeoutMs?: number;
  }): Promise<ContentionProbeSuccess> {
    const timeoutMs = params.timeoutMs ?? 15000;
    const deadline = Date.now() + timeoutMs;
    let lastChain: BlockedRacerRow[] = [];
    let lastRelationMatched: BlockedRacerRow[] = [];

    while (Date.now() < deadline) {
      // Snapshot all racer backends + blockers; do not pre-filter to direct gate waits
      // (Racer B may queue behind Racer A while A waits on the gate).
      const rows = await sessionObserver.$queryRaw<BlockedRacerRow[]>`
        SELECT
          a.pid,
          a.application_name,
          COALESCE(pg_blocking_pids(a.pid), ARRAY[]::int[]) AS blockers,
          (
            SELECT array_agg(DISTINCT c.relname)
            FROM pg_locks l
            JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid = a.pid
              AND NOT l.granted
              AND c.relname IS NOT NULL
          ) AS waiting_relations
        FROM pg_stat_activity a
        WHERE a.application_name IN ('winger-s23-a', 'winger-s23-b')
          AND a.pid <> ${params.gatePid}
      `;

      const chain = resolveGatedContentionChain(rows, params.gatePid);
      const withRelation = chain.filter((r) =>
        (r.waiting_relations ?? []).includes(params.gatedRelation),
      );
      lastChain = chain;
      lastRelationMatched = withRelation;

      // Prefer relation-matched members when enough are visible; otherwise accept
      // the full gate-rooted chain (transactionid waits often omit relation oids).
      const usedRelationMatch = withRelation.length >= params.minDistinctRacers;
      const chosen = usedRelationMatch ? withRelation : chain;
      const distinctPids = [...new Set(chosen.map((r) => Number(r.pid)))];
      if (distinctPids.length >= params.minDistinctRacers) {
        return {
          gatePid: params.gatePid,
          gatedRelation: params.gatedRelation,
          observedChainRacerPids: distinctPids,
          relationMatchedRacerPids: [
            ...new Set(withRelation.map((r) => Number(r.pid))),
          ],
          usedRelationMatch,
          racerBlockers: chain.map((r) => ({
            pid: Number(r.pid),
            application_name: r.application_name,
            blockers: (r.blockers ?? []).map((b) => Number(b)),
          })),
        };
      }
      await new Promise((r) => setTimeout(r, 15));
    }

    const diagnostics = await snapshotRacerLockDiagnostics(params.gatePid);
    const observed = [...new Set(lastChain.map((r) => Number(r.pid)))];
    const relationObserved = [
      ...new Set(lastRelationMatched.map((r) => Number(r.pid))),
    ];
    throw new Error(
      [
        `S2.3 contention probe failed: expected ${params.minDistinctRacers} distinct racer PID(s)`,
        `in gate-rooted chain (direct or transitive) gatePid=${params.gatePid}`,
        `relation=${params.gatedRelation}`,
        `observedChainRacerPids=[${observed.join(',')}]`,
        `relationMatchedRacerPids=[${relationObserved.join(',')}]`,
        `lastChain=${JSON.stringify(lastChain)}`,
        `activity=${JSON.stringify(diagnostics)}`,
      ].join(' | '),
    );
  }

  /**
   * Hold a contested row lock on sessionGate, start both racers (they block),
   * then release the gate so they contend for real.
   * Fails unless a gate-rooted contention chain includes the required distinct
   * racer PIDs (direct gate waiters and/or transitive queue behind them).
   */
  async function contendAfterGateRelease<T, U>(
    gatedRelation: GatedRelation,
    acquireGate: (tx: {
      $executeRaw: (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<unknown>;
      $queryRaw: (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<unknown>;
    }) => Promise<void>,
    opA: () => Promise<T>,
    opB: () => Promise<U>,
    opts?: { minWaiters?: number; timeoutMs?: number },
  ): Promise<[PromiseSettledResult<T>, PromiseSettledResult<U>]> {
    let releaseGate!: () => void;
    let gateReleased = false;
    const gateMayRelease = new Promise<void>((resolve) => {
      releaseGate = () => {
        if (!gateReleased) {
          gateReleased = true;
          resolve();
        }
      };
    });
    let signalHeld!: () => void;
    const gateHeld = new Promise<void>((resolve) => {
      signalHeld = resolve;
    });
    let gatePid = 0;

    const gateTxn = sessionGate.$transaction(
      async (tx) => {
        await acquireGate(tx);
        const pidRows = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::int AS pid
        `;
        gatePid = Number(pidRows[0]?.pid ?? 0);
        if (!gatePid) {
          throw new Error('sessionGate failed to report pg_backend_pid()');
        }
        signalHeld();
        await gateMayRelease;
      },
      { maxWait: 120000, timeout: 120000 },
    );

    await gateHeld;
    const raced = Promise.allSettled([opA(), opB()]);
    try {
      const probe = await waitUntilRacersBlockedByGate({
        gatePid,
        gatedRelation,
        minDistinctRacers: opts?.minWaiters ?? 2,
        timeoutMs: opts?.timeoutMs,
      });
      // Success-path diagnostics for authorised PostgreSQL reports.
      // eslint-disable-next-line no-console
      console.info(
        `[S2.3 contention] ${JSON.stringify({
          ...probe,
          note: probe.usedRelationMatch
            ? 'relation-matched chain'
            : 'gate-rooted chain fallback (relation visibility may be sparse)',
        })}`,
      );
      releaseGate();
      const results = await raced;
      await gateTxn;
      return results as [PromiseSettledResult<T>, PromiseSettledResult<U>];
    } catch (err) {
      // Always free the gate so racers cannot hang after a probe failure.
      releaseGate();
      await Promise.allSettled([raced, gateTxn]);
      throw err;
    } finally {
      releaseGate();
    }
  }

  async function seedShipmentPair(label: string, paymentTotal: number) {
    const orderId = `${run}-ord-${label}`;
    const itemId = `${run}-item-${label}`;
    const shipId = `${run}-ship-${label}`;
    const retA = `${run}-ret-${label}-a`;
    const retB = `${run}-ret-${label}-b`;
    const productId = `${run}-prod`;
    const paymentTotalCents = dollarsToCentsExact(paymentTotal);

    // Product must exist before OrderItem (OrderItem_productId_fkey).
    // Shared run-scoped id; upsert so repeated scenario seeds stay idempotent.
    await sessionA.product.upsert({
      where: { id: productId },
      create: {
        id: productId,
        name: 'S23 Widget',
        brand: 'S23 Fixture',
        supplierId,
        supplierName: 'S23 Supplier',
        price: paymentTotal,
        imageUrl: 'https://example.invalid/s23-widget.png',
        category: 's23-fixture',
      },
      update: {},
    });

    await sessionA.order.create({
      data: {
        id: orderId,
        displayId: `S23-${label}`,
        customerId,
        customerName: 'S23',
        customerEmail: `${run}@s23.invalid`,
        subtotal: paymentTotal,
        total: paymentTotal,
        currency: 'usd',
        paymentMode: 'test',
        paymentStatus: 'PAID',
        status: 'DELIVERED',
        stripePaymentIntentId: `pi_${label}_${run}`,
      } as never,
    });
    await sessionA.orderItem.create({
      data: {
        id: itemId,
        orderId,
        productId,
        productName: 'Widget',
        supplierId,
        supplierName: 'S23 Supplier',
        unitPrice: paymentTotal,
        quantity: 1,
        lineTotal: paymentTotal,
        status: 'DELIVERED',
      } as never,
    });
    await sessionA.orderShipment.create({
      data: {
        id: shipId,
        orderId,
        supplierId,
        supplierName: 'S23 Supplier',
        merchandise: paymentTotal,
        deliveryFee: 0,
        merchandiseTax: 0,
        deliveryTax: 0,
        paymentMerchandise: paymentTotal,
        paymentDelivery: 0,
        paymentTax: 0,
        refundedAmount: 0,
      } as never,
    });
    for (const retId of [retA, retB]) {
      await sessionA.returnRequest.create({
        data: {
          id: retId,
          orderId,
          orderItemId: itemId,
          customerId,
          reason: 'test',
          quantity: 1,
          status: ReturnRequestStatus.APPROVED,
          refundStatus: ReturnRefundStatus.PENDING,
          refundDrive: ReturnRefundDrive.LEGACY,
        } as never,
      });
    }
    return { orderId, shipId, retA, retB, itemId, paymentTotalCents };
  }

  async function reserveHold(
    db: PrismaClient,
    input: {
      returnRequestId: string;
      orderShipmentId: string;
      returnedMerchandise: number;
    },
  ) {
    const svc = holds(db);
    return db.$transaction(async (tx) => {
      await svc.lockReturnRequest(tx, input.returnRequestId);
      return svc.reserveInTransaction(tx, {
        returnRequestId: input.returnRequestId,
        orderShipmentId: input.orderShipmentId,
        supplierId,
        currency: 'usd',
        returnedMerchandise: input.returnedMerchandise,
        includeDelivery: false,
        siblingHadLiveLine: true,
      });
    });
  }

  /**
   * Minimum ATTEMPT clawback reservation for applyReturnClawbackForAttempt.
   * Uses a jest ledger mock (not CommissionLedgerService): the mock must return
   * { legacy: false, applied: true } so the production boundary does not throw.
   * CommissionClawback.appliedAt stays null under the mock — do not assert it.
   */
  async function seedAttemptClawbackReservation(input: {
    orderItemId: string;
    returnRequestId: string;
    quantity: number;
    merchandiseAmount: number;
    ratePercent?: number;
  }) {
    const ratePercent = input.ratePercent ?? 10;
    const commissionAmount = Number(
      ((input.merchandiseAmount * ratePercent) / 100).toFixed(2),
    );
    const commissionId = `${input.returnRequestId}-oic`;
    const clawbackId = `${input.returnRequestId}-claw`;

    await sessionA.orderItemCommission.create({
      data: {
        id: commissionId,
        orderItemId: input.orderItemId,
        ratePercent,
        commissionBase: input.merchandiseAmount,
        commissionAmount,
        currency: 'USD',
        status: CommissionRecognitionStatus.SETTLEABLE,
        paymentMode: 'test',
        isDemo: false,
        settleableAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    await sessionA.commissionClawback.create({
      data: {
        id: clawbackId,
        orderItemCommissionId: commissionId,
        returnRequestId: input.returnRequestId,
        quantity: input.quantity,
        merchandiseAmount: input.merchandiseAmount,
        commissionAmount,
        appliedAt: null,
      },
    });

    return { commissionId, clawbackId, commissionAmount, ratePercent };
  }

  it('1) concurrent $70 and $60 against $100: exactly one succeeds', async () => {
    const { shipId, retA, retB, paymentTotalCents } = await seedShipmentPair(
      'cap',
      100,
    );
    const holdA = holds(sessionA);
    const holdB = holds(sessionB);

    const results = await Promise.allSettled([
      sessionA.$transaction(async (tx) => {
        await holdA.lockReturnRequest(tx, retA);
        return holdA.reserveInTransaction(tx, {
          returnRequestId: retA,
          orderShipmentId: shipId,
          supplierId,
          currency: 'usd',
          returnedMerchandise: 70,
          includeDelivery: false,
          siblingHadLiveLine: true,
        });
      }),
      sessionB.$transaction(async (tx) => {
        await holdB.lockReturnRequest(tx, retB);
        return holdB.reserveInTransaction(tx, {
          returnRequestId: retB,
          orderShipmentId: shipId,
          supplierId,
          currency: 'usd',
          returnedMerchandise: 60,
          includeDelivery: false,
          siblingHadLiveLine: true,
        });
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const reserved = await sessionA.shipmentRefundHold.findMany({
      where: {
        orderShipmentId: shipId,
        status: ShipmentRefundHoldStatus.RESERVED,
      },
    });
    expect(reserved).toHaveLength(1);
    expect([70, 60]).toContain(Number(reserved[0]!.amount));
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('2) dual-session ATTEMPT submit versus abandonment', async () => {
    // --- Phase A: genuine dual-session race (either txn may win under RC) ---
    {
      const { orderId, shipId, retA, itemId, paymentTotalCents } =
        await seedShipmentPair('subabd', 40);
      await sessionA.returnRequest.update({
        where: { id: retA },
        data: { refundDrive: ReturnRefundDrive.ATTEMPT },
      });
      const createRefund = jest.fn(async () => ({
        ok: true as const,
        refund: {
          id: `re_subabd_${run}`,
          status: 'succeeded',
          failureReason: null,
        },
      }));
      const reserved = await reserveHold(sessionA, {
        returnRequestId: retA,
        orderShipmentId: shipId,
        returnedMerchandise: 40,
      });
      const attemptSvc = attempts(sessionA, {
        createRefundForAttempt: createRefund,
      });
      const ensured = await attemptSvc.ensureAttemptForOperation({
        kind: 'RETURN',
        operationKey: operationKeyForReturn(retA),
        orderId,
        actorUserId: adminId,
        stripePaymentIntentId: `pi_subabd_${run}`,
        amount: reserved.amount,
        amountCents: reserved.amountCents,
        currency: 'usd',
        returnRequestId: retA,
        orderItemId: itemId,
        orderShipmentId: shipId,
        supplierId,
      });
      await sessionA.shipmentRefundHold.update({
        where: { id: reserved.id },
        data: { refundAttemptId: ensured.attempt.id },
      });

      const holdB = holds(sessionB);
      const attemptA = attempts(sessionA, {
        createRefundForAttempt: createRefund,
      });

      const [abandonResult, submitResult] = await contendAfterGateRelease(
        'RefundAttempt',
        async (tx) => {
          await tx.$executeRaw`
            SELECT id FROM "RefundAttempt" WHERE id = ${ensured.attempt.id} FOR UPDATE
          `;
        },
        () => holdB.requestAbandonment({ returnRequestId: retA }),
        () =>
          attemptA.submitCurrentSubmission({
            refundAttemptId: ensured.attempt.id,
          }),
      );

      expect(abandonResult.status).toBe('fulfilled');
      expect(submitResult.status).toBe('fulfilled');
      const submit =
        submitResult.status === 'fulfilled' ? submitResult.value : null;

      const rr = await sessionA.returnRequest.findUniqueOrThrow({
        where: { id: retA },
      });
      expect(rr.refundAbandonRequestedAt).toBeTruthy();
      const hold = await sessionA.shipmentRefundHold.findUniqueOrThrow({
        where: { returnRequestId: retA },
      });
      const attempt = await sessionA.refundAttempt.findUniqueOrThrow({
        where: { id: ensured.attempt.id },
      });
      const subs = await sessionA.refundAttemptSubmission.findMany({
        where: { refundAttemptId: attempt.id },
      });

      // Winner detection from persisted Stripe-create evidence (not Promise timing).
      // Under READ COMMITTED, submit's claim txn may commit before abandon's
      // refundAbandonRequestedAt is visible, so either outcome is legitimate.
      const submitClaimWon =
        submit?.created === true || createRefund.mock.calls.length > 0;

      if (submitClaimWon) {
        expect(submit?.created).toBe(true);
        expect(createRefund).toHaveBeenCalled();
        expect(attempt.stripeRefundId).toBe(`re_subabd_${run}`);
        expect(attempt.status).not.toBe(RefundAttemptStatus.PERMANENTLY_FAILED);
        // Stripe create already ran — hold must remain RESERVED (not RELEASED).
        expect(hold.status).toBe(ShipmentRefundHoldStatus.RESERVED);
        expect(subs.some((s) => s.stripeRefundId === `re_subabd_${run}`)).toBe(
          true,
        );
      } else {
        expect(submit?.created).toBe(false);
        expect(submit?.blockedReason).toMatch(
          /abandon|permanently_failed|hold_released|return_abandon/,
        );
        expect(createRefund).not.toHaveBeenCalled();
        expect(hold.status).toBe(ShipmentRefundHoldStatus.RELEASED);
        expect(attempt.status).toBe(RefundAttemptStatus.PERMANENTLY_FAILED);
        expect(subs.every((s) => !s.stripeRefundId)).toBe(true);
      }

      // Cross-check: never RELEASED if a Stripe create could still succeed / already did.
      if (createRefund.mock.calls.length > 0 || attempt.stripeRefundId) {
        expect(hold.status).not.toBe(ShipmentRefundHoldStatus.RELEASED);
      }

      await assertShipmentCapacityInvariantCents(
        sessionA,
        shipId,
        paymentTotalCents,
      );
    }

    // --- Phase B: submit claim commits first; abandon during in-flight mock Stripe ---
    {
      const { orderId, shipId, retA, itemId, paymentTotalCents } =
        await seedShipmentPair('subwin', 40);
      await sessionA.returnRequest.update({
        where: { id: retA },
        data: { refundDrive: ReturnRefundDrive.ATTEMPT },
      });

      let releaseStripe!: () => void;
      const stripeMayFinish = new Promise<void>((resolve) => {
        releaseStripe = resolve;
      });
      let signalStripeEntered!: () => void;
      const stripeEntered = new Promise<void>((resolve) => {
        signalStripeEntered = resolve;
      });

      const createRefund = jest.fn(async () => {
        signalStripeEntered();
        await stripeMayFinish;
        return {
          ok: true as const,
          refund: {
            id: `re_subwin_${run}`,
            status: 'succeeded',
            failureReason: null,
          },
        };
      });

      const reserved = await reserveHold(sessionA, {
        returnRequestId: retA,
        orderShipmentId: shipId,
        returnedMerchandise: 40,
      });
      const setupAttempts = attempts(sessionA, {
        createRefundForAttempt: createRefund,
      });
      const ensured = await setupAttempts.ensureAttemptForOperation({
        kind: 'RETURN',
        operationKey: operationKeyForReturn(retA),
        orderId,
        actorUserId: adminId,
        stripePaymentIntentId: `pi_subwin_${run}`,
        amount: reserved.amount,
        amountCents: reserved.amountCents,
        currency: 'usd',
        returnRequestId: retA,
        orderItemId: itemId,
        orderShipmentId: shipId,
        supplierId,
      });
      await sessionA.shipmentRefundHold.update({
        where: { id: reserved.id },
        data: { refundAttemptId: ensured.attempt.id },
      });

      const attemptA = attempts(sessionA, {
        createRefundForAttempt: createRefund,
      });
      const holdB = holds(sessionB);

      const submitPromise = attemptA.submitCurrentSubmission({
        refundAttemptId: ensured.attempt.id,
      });
      await stripeEntered;
      // Claim txn committed with submittedAt; Stripe still in flight.
      const midSub = await sessionA.refundAttemptSubmission.findFirstOrThrow({
        where: { refundAttemptId: ensured.attempt.id },
        orderBy: { version: 'desc' },
      });
      expect(midSub.submittedAt).toBeTruthy();

      const abandonPromise = holdB.requestAbandonment({
        returnRequestId: retA,
      });
      const abandonResult = await abandonPromise;
      expect(abandonResult.refundAbandonRequestedAt).toBeTruthy();

      const holdDuringFlight =
        await sessionA.shipmentRefundHold.findUniqueOrThrow({
          where: { returnRequestId: retA },
        });
      // Unresolved in-flight submit must not release capacity.
      expect(holdDuringFlight.status).toBe(ShipmentRefundHoldStatus.RESERVED);

      releaseStripe();
      const submit = await submitPromise;
      expect(submit.created).toBe(true);
      expect(createRefund).toHaveBeenCalledTimes(1);

      const holdAfter = await sessionA.shipmentRefundHold.findUniqueOrThrow({
        where: { returnRequestId: retA },
      });
      expect(holdAfter.status).toBe(ShipmentRefundHoldStatus.RESERVED);
      const attempt = await sessionA.refundAttempt.findUniqueOrThrow({
        where: { id: ensured.attempt.id },
      });
      expect(attempt.stripeRefundId).toBe(`re_subwin_${run}`);
      expect(attempt.status).not.toBe(RefundAttemptStatus.PERMANENTLY_FAILED);
      await assertShipmentCapacityInvariantCents(
        sessionA,
        shipId,
        paymentTotalCents,
      );
    }
  });

  it('3) dual-session ATTEMPT abandonment versus successful apply', async () => {
    const merchandise = 55;
    const { orderId, shipId, retA, itemId, paymentTotalCents } =
      await seedShipmentPair('abdapp', merchandise);
    await sessionA.returnRequest.update({
      where: { id: retA },
      data: { refundDrive: ReturnRefundDrive.ATTEMPT },
    });
    // Real reservation + snapshot so applyReturnClawbackForAttempt reaches ledger.
    await seedAttemptClawbackReservation({
      orderItemId: itemId,
      returnRequestId: retA,
      quantity: 1,
      merchandiseAmount: merchandise,
    });
    const clawback = createClawbackTracker();
    const reserved = await reserveHold(sessionA, {
      returnRequestId: retA,
      orderShipmentId: shipId,
      returnedMerchandise: merchandise,
    });
    const setup = attempts(sessionA, { clawback: clawback.fn });
    const ensured = await setup.ensureAttemptForOperation({
      kind: 'RETURN',
      operationKey: operationKeyForReturn(retA),
      orderId,
      actorUserId: adminId,
      stripePaymentIntentId: `pi_abdapp_${run}`,
      amount: reserved.amount,
      amountCents: reserved.amountCents,
      currency: 'usd',
      returnRequestId: retA,
      orderItemId: itemId,
      orderShipmentId: shipId,
      supplierId,
    });
    await sessionA.shipmentRefundHold.update({
      where: { id: reserved.id },
      data: { refundAttemptId: ensured.attempt.id },
    });
    await sessionA.refundAttempt.update({
      where: { id: ensured.attempt.id },
      data: {
        status: RefundAttemptStatus.STRIPE_SUCCEEDED,
        stripeRefundId: `re_abdapp_${run}`,
      },
    });
    await sessionA.refundAttemptSubmission.update({
      where: { id: ensured.submission.id },
      data: {
        outcome: RefundSubmissionOutcome.SUCCEEDED,
        stripeRefundId: `re_abdapp_${run}`,
        reconciliationResult: RefundReconciliationResult.MATCHED,
        submittedAt: new Date(),
      },
    });

    const holdB = holds(sessionB, clawback.fn);
    const attemptA = attempts(sessionA, { clawback: clawback.fn });

    const [abandonResult, applyResult] = await contendAfterGateRelease(
      'RefundAttempt',
      async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "RefundAttempt" WHERE id = ${ensured.attempt.id} FOR UPDATE
        `;
      },
      () => holdB.requestAbandonment({ returnRequestId: retA }),
      () =>
        attemptA.applySuccessfulRefund({
          refundAttemptId: ensured.attempt.id,
          actor,
        }),
    );

    const hold = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    const attempt = await sessionA.refundAttempt.findUniqueOrThrow({
      where: { id: ensured.attempt.id },
    });
    const ship = await sessionA.orderShipment.findUniqueOrThrow({
      where: { id: shipId },
    });
    const rr = await sessionA.returnRequest.findUniqueOrThrow({
      where: { id: retA },
    });
    const reservation = await sessionA.commissionClawback.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });

    expect(abandonResult.status).toBe('fulfilled');
    expect(rr.refundAbandonRequestedAt).toBeTruthy();
    // Success evidence exists — abandon must never RELEASE.
    expect(hold.status).not.toBe(ShipmentRefundHoldStatus.RELEASED);

    if (applyResult.status === 'fulfilled') {
      expect(hold.status).toBe(ShipmentRefundHoldStatus.CONSUMED);
      expect(attempt.status).toBe(RefundAttemptStatus.APPLIED);
      expect(attempt.clawbackAppliedAt).toBeTruthy();
      expect(dollarsToCentsExact(Number(ship.refundedAmount))).toBe(
        reserved.amountCents,
      );
      // Ledger mock boundary: exactly one applyReturnClawback for this return.
      expect(clawback.calls).toBe(1);
      expect(clawback.mock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ returnRequestId: retA, actor }),
      );
    } else {
      expect(hold.status).toBe(ShipmentRefundHoldStatus.RESERVED);
      expect(dollarsToCentsExact(Number(ship.refundedAmount))).toBe(0);
      expect(clawback.calls).toBe(0);
    }
    // Mock ledger does not persist appliedAt — reservation stays unapplied in DB.
    expect(reservation.appliedAt).toBeNull();

    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('4) two concurrent apply calls: exactly one money movement', async () => {
    const merchandise = 45;
    const { orderId, shipId, retA, itemId, paymentTotalCents } =
      await seedShipmentPair('capp', merchandise);
    await sessionA.returnRequest.update({
      where: { id: retA },
      data: { refundDrive: ReturnRefundDrive.ATTEMPT },
    });
    await seedAttemptClawbackReservation({
      orderItemId: itemId,
      returnRequestId: retA,
      quantity: 1,
      merchandiseAmount: merchandise,
    });
    const clawback = createClawbackTracker();
    const holdSvc = holds(sessionA, clawback.fn);
    const a = attempts(sessionA, { clawback: clawback.fn });
    const b = attempts(sessionB, { clawback: clawback.fn });
    const reserved = await sessionA.$transaction(async (tx) => {
      await holdSvc.lockReturnRequest(tx, retA);
      return holdSvc.reserveInTransaction(tx, {
        returnRequestId: retA,
        orderShipmentId: shipId,
        supplierId,
        currency: 'usd',
        returnedMerchandise: merchandise,
        includeDelivery: false,
        siblingHadLiveLine: true,
      });
    });
    const ensured = await a.ensureAttemptForOperation({
      kind: 'RETURN',
      operationKey: operationKeyForReturn(retA),
      orderId,
      actorUserId: adminId,
      stripePaymentIntentId: `pi_capp_${run}`,
      amount: reserved.amount,
      amountCents: reserved.amountCents,
      currency: 'usd',
      returnRequestId: retA,
      orderItemId: itemId,
      orderShipmentId: shipId,
      supplierId,
    });
    await sessionA.shipmentRefundHold.update({
      where: { id: reserved.id },
      data: { refundAttemptId: ensured.attempt.id },
    });
    await sessionA.refundAttempt.update({
      where: { id: ensured.attempt.id },
      data: {
        status: RefundAttemptStatus.STRIPE_SUCCEEDED,
        stripeRefundId: `re_capp_${run}`,
      },
    });
    await sessionA.refundAttemptSubmission.update({
      where: { id: ensured.submission.id },
      data: {
        outcome: RefundSubmissionOutcome.SUCCEEDED,
        stripeRefundId: `re_capp_${run}`,
        reconciliationResult: RefundReconciliationResult.MATCHED,
        submittedAt: new Date(),
      },
    });

    const results = await contendAfterGateRelease(
      'RefundAttempt',
      async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "RefundAttempt" WHERE id = ${ensured.attempt.id} FOR UPDATE
        `;
      },
      () =>
        a.applySuccessfulRefund({
          refundAttemptId: ensured.attempt.id,
          actor,
        }),
      () =>
        b.applySuccessfulRefund({
          refundAttemptId: ensured.attempt.id,
          actor,
        }),
    );
    expect(
      results.filter((r) => r.status === 'fulfilled').length,
    ).toBeGreaterThanOrEqual(1);
    const ship = await sessionA.orderShipment.findUniqueOrThrow({
      where: { id: shipId },
    });
    expect(dollarsToCentsExact(Number(ship.refundedAmount))).toBe(
      reserved.amountCents,
    );
    const hold = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    expect(hold.status).toBe(ShipmentRefundHoldStatus.CONSUMED);
    const attempt = await sessionA.refundAttempt.findUniqueOrThrow({
      where: { id: ensured.attempt.id },
    });
    expect(attempt.status).toBe(RefundAttemptStatus.APPLIED);
    expect(attempt.clawbackAppliedAt).toBeTruthy();
    // Winner exercises ATTEMPT→ledger; loser is idempotent / does not double-call.
    expect(clawback.calls).toBe(1);
    expect(clawback.mock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ returnRequestId: retA, actor }),
    );
    const reservation = await sessionA.commissionClawback.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    // Mock ledger does not write appliedAt.
    expect(reservation.appliedAt).toBeNull();
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('5) concurrent apply and new reservation on same shipment', async () => {
    const { orderId, shipId, retA, retB, itemId, paymentTotalCents } =
      await seedShipmentPair('appres', 100);
    await sessionA.returnRequest.update({
      where: { id: retA },
      data: { refundDrive: ReturnRefundDrive.ATTEMPT },
    });
    const holdA = holds(sessionA);
    const holdB = holds(sessionB);
    const attemptSvc = attempts(sessionA);
    const reserved = await sessionA.$transaction(async (tx) => {
      await holdA.lockReturnRequest(tx, retA);
      return holdA.reserveInTransaction(tx, {
        returnRequestId: retA,
        orderShipmentId: shipId,
        supplierId,
        currency: 'usd',
        returnedMerchandise: 60,
        includeDelivery: false,
        siblingHadLiveLine: true,
      });
    });
    const ensured = await attemptSvc.ensureAttemptForOperation({
      kind: 'RETURN',
      operationKey: operationKeyForReturn(retA),
      orderId,
      actorUserId: adminId,
      stripePaymentIntentId: `pi_appres_${run}`,
      amount: reserved.amount,
      amountCents: reserved.amountCents,
      currency: 'usd',
      returnRequestId: retA,
      orderItemId: itemId,
      orderShipmentId: shipId,
      supplierId,
    });
    await sessionA.shipmentRefundHold.update({
      where: { id: reserved.id },
      data: { refundAttemptId: ensured.attempt.id },
    });
    await sessionA.refundAttempt.update({
      where: { id: ensured.attempt.id },
      data: {
        status: RefundAttemptStatus.STRIPE_SUCCEEDED,
        stripeRefundId: `re_appres_${run}`,
      },
    });
    await sessionA.refundAttemptSubmission.update({
      where: { id: ensured.submission.id },
      data: {
        outcome: RefundSubmissionOutcome.SUCCEEDED,
        stripeRefundId: `re_appres_${run}`,
        reconciliationResult: RefundReconciliationResult.MATCHED,
        submittedAt: new Date(),
      },
    });

    const [applyResult, reserveResult] = await Promise.allSettled([
      attemptSvc.applySuccessfulRefund({
        refundAttemptId: ensured.attempt.id,
        actor,
      }),
      sessionB.$transaction(async (tx) => {
        await holdB.lockReturnRequest(tx, retB);
        return holdB.reserveInTransaction(tx, {
          returnRequestId: retB,
          orderShipmentId: shipId,
          supplierId,
          currency: 'usd',
          returnedMerchandise: 50,
          includeDelivery: false,
          siblingHadLiveLine: true,
        });
      }),
    ]);

    expect(applyResult.status).toBe('fulfilled');
    const ship = await sessionA.orderShipment.findUniqueOrThrow({
      where: { id: shipId },
    });
    expect(dollarsToCentsExact(Number(ship.refundedAmount))).toBe(6000);
    if (reserveResult.status === 'fulfilled') {
      expect(Number((reserveResult.value as { amount: number }).amount)).toBe(
        50,
      );
    }
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('6) LEGACY pre-Stripe claim racing with abandonment', async () => {
    const { shipId, retA, paymentTotalCents } = await seedShipmentPair(
      'legabd',
      35,
    );
    const a = holds(sessionA);
    const b = holds(sessionB);
    await reserveHold(sessionA, {
      returnRequestId: retA,
      orderShipmentId: shipId,
      returnedMerchandise: 35,
    });

    const [claimResult, abandonResult] = await contendAfterGateRelease(
      'ReturnRequest',
      async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "ReturnRequest" WHERE id = ${retA} FOR UPDATE
        `;
      },
      () => a.claimLegacyStripeBeforeNetwork({ returnRequestId: retA }),
      () => b.requestAbandonment({ returnRequestId: retA }),
    );

    const hold = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    if (claimResult.status === 'fulfilled' && claimResult.value.freshClaim) {
      expect(hold.legacyStripeClaimedAt).toBeTruthy();
      if (abandonResult.status === 'fulfilled') {
        expect(hold.status).toBe(ShipmentRefundHoldStatus.RESERVED);
      }
    } else {
      expect(abandonResult.status).toBe('fulfilled');
    }
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('7) LEGACY crash after claim before outcome: capacity stays reserved', async () => {
    const { shipId, retA, paymentTotalCents } = await seedShipmentPair(
      'crash',
      28,
    );
    const service = holds(sessionA);
    await reserveHold(sessionA, {
      returnRequestId: retA,
      orderShipmentId: shipId,
      returnedMerchandise: 28,
    });
    const claimed = await service.claimLegacyStripeBeforeNetwork({
      returnRequestId: retA,
    });
    expect(claimed.freshClaim).toBe(true);
    const hold = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    expect(hold.status).toBe(ShipmentRefundHoldStatus.RESERVED);
    expect(hold.legacyStripeOutcome).toBeNull();
    const reuse = await service.claimLegacyStripeBeforeNetwork({
      returnRequestId: retA,
    });
    expect(reuse.freshClaim).toBe(false);
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('8) FAILED_TERMINAL + abandonment releases capacity for reuse', async () => {
    const { shipId, retA, retB, paymentTotalCents } = await seedShipmentPair(
      'fail',
      80,
    );
    const service = holds(sessionA);
    await reserveHold(sessionA, {
      returnRequestId: retA,
      orderShipmentId: shipId,
      returnedMerchandise: 80,
    });
    await service.claimLegacyStripeBeforeNetwork({ returnRequestId: retA });
    await service.recordLegacyStripeOutcome({
      returnRequestId: retA,
      outcome: 'FAILED_TERMINAL',
    });
    await service.requestAbandonment({ returnRequestId: retA });
    const released = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    expect(released.status).toBe(ShipmentRefundHoldStatus.RELEASED);

    const reused = await reserveHold(sessionA, {
      returnRequestId: retB,
      orderShipmentId: shipId,
      returnedMerchandise: 80,
    });
    expect(reused.status).toBe(ShipmentRefundHoldStatus.RESERVED);
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('9) unknown LEGACY outcome + abandonment retains RESERVED capacity', async () => {
    const { shipId, retA, paymentTotalCents } = await seedShipmentPair(
      'unk',
      50,
    );
    const service = holds(sessionA);
    await reserveHold(sessionA, {
      returnRequestId: retA,
      orderShipmentId: shipId,
      returnedMerchandise: 50,
    });
    await service.claimLegacyStripeBeforeNetwork({ returnRequestId: retA });
    await service.requestAbandonment({ returnRequestId: retA });
    const hold = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    expect(hold.status).toBe(ShipmentRefundHoldStatus.RESERVED);
    expect(hold.legacyStripeOutcome).toBeNull();
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('10) NO_MATCH then v2 reuses same hold and frozen amount', async () => {
    const { orderId, shipId, retA, itemId, paymentTotalCents } =
      await seedShipmentPair('nomatch', 33);
    await sessionA.returnRequest.update({
      where: { id: retA },
      data: { refundDrive: ReturnRefundDrive.ATTEMPT },
    });
    const holdSvc = holds(sessionA);
    const attemptSvc = attempts(sessionA);
    const reserved = await sessionA.$transaction(async (tx) => {
      await holdSvc.lockReturnRequest(tx, retA);
      return holdSvc.reserveInTransaction(tx, {
        returnRequestId: retA,
        orderShipmentId: shipId,
        supplierId,
        currency: 'usd',
        returnedMerchandise: 33,
        includeDelivery: false,
        siblingHadLiveLine: true,
      });
    });
    const ensured = await attemptSvc.ensureAttemptForOperation({
      kind: 'RETURN',
      operationKey: operationKeyForReturn(retA),
      orderId,
      actorUserId: adminId,
      stripePaymentIntentId: `pi_nomatch_${run}`,
      amount: reserved.amount,
      amountCents: reserved.amountCents,
      currency: 'usd',
      returnRequestId: retA,
      orderItemId: itemId,
      orderShipmentId: shipId,
      supplierId,
    });
    await sessionA.shipmentRefundHold.update({
      where: { id: reserved.id },
      data: { refundAttemptId: ensured.attempt.id },
    });
    await sessionA.refundAttemptSubmission.update({
      where: { id: ensured.submission.id },
      data: {
        outcome: RefundSubmissionOutcome.FAILED,
        reconciliationResult: RefundReconciliationResult.MATCHED,
        submittedAt: new Date(),
      },
    });
    await sessionA.refundAttempt.update({
      where: { id: ensured.attempt.id },
      data: { status: RefundAttemptStatus.STRIPE_FAILED },
    });

    const again = await attemptSvc.ensureAttemptForOperation({
      kind: 'RETURN',
      operationKey: operationKeyForReturn(retA),
      orderId,
      actorUserId: adminId,
      stripePaymentIntentId: `pi_nomatch_${run}`,
      amount: reserved.amount,
      amountCents: reserved.amountCents,
      currency: 'usd',
      returnRequestId: retA,
      orderItemId: itemId,
      orderShipmentId: shipId,
      supplierId,
    });
    expect(again.attempt.id).toBe(ensured.attempt.id);
    expect(again.attempt.amountCents).toBe(reserved.amountCents);
    const holdsForReturn = await sessionA.shipmentRefundHold.findMany({
      where: { returnRequestId: retA },
    });
    expect(holdsForReturn).toHaveLength(1);
    expect(Number(holdsForReturn[0]!.amount)).toBe(reserved.amount);
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('11) abandonment after SUCCESS_PENDING_FINALIZE does not release; finalize consumes', async () => {
    const { shipId, retA, paymentTotalCents } = await seedShipmentPair(
      'pendfin',
      22,
    );
    const service = holds(sessionA);
    await reserveHold(sessionA, {
      returnRequestId: retA,
      orderShipmentId: shipId,
      returnedMerchandise: 22,
    });
    await service.claimLegacyStripeBeforeNetwork({ returnRequestId: retA });
    await service.recordLegacyStripeOutcome({
      returnRequestId: retA,
      outcome: 'SUCCESS_PENDING_FINALIZE',
    });
    const abandon = await service.requestAbandonment({ returnRequestId: retA });
    expect(abandon.refundAbandonRequestedAt).toBeTruthy();
    const afterAbandon = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    expect(afterAbandon.status).toBe(ShipmentRefundHoldStatus.RESERVED);

    await service.finalizeLegacySuccessfulRefund({
      returnRequestId: retA,
      actor,
    });
    const finalHold = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    expect(finalHold.status).toBe(ShipmentRefundHoldStatus.CONSUMED);
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('12) release racing with another return reservation stays consistent', async () => {
    const { shipId, retA, retB, paymentTotalCents } = await seedShipmentPair(
      'race',
      100,
    );
    const a = holds(sessionA);
    const b = holds(sessionB);

    await reserveHold(sessionA, {
      returnRequestId: retA,
      orderShipmentId: shipId,
      returnedMerchandise: 100,
    });
    await a.claimLegacyStripeBeforeNetwork({ returnRequestId: retA });
    await a.recordLegacyStripeOutcome({
      returnRequestId: retA,
      outcome: 'FAILED_TERMINAL',
    });

    const [abandonResult, reserveResult] = await contendAfterGateRelease(
      'OrderShipment',
      async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "OrderShipment" WHERE id = ${shipId} FOR UPDATE
        `;
      },
      () => a.requestAbandonment({ returnRequestId: retA }),
      () =>
        sessionB.$transaction(async (tx) => {
          await b.lockReturnRequest(tx, retB);
          return b.reserveInTransaction(tx, {
            returnRequestId: retB,
            orderShipmentId: shipId,
            supplierId,
            currency: 'usd',
            returnedMerchandise: 100,
            includeDelivery: false,
            siblingHadLiveLine: true,
          });
        }),
    );

    expect(abandonResult.status).toBe('fulfilled');
    const reserved = await sessionA.shipmentRefundHold.findMany({
      where: {
        orderShipmentId: shipId,
        status: ShipmentRefundHoldStatus.RESERVED,
      },
    });
    expect(reserved.length).toBeLessThanOrEqual(1);
    if (reserveResult.status === 'fulfilled') {
      expect(reserved).toHaveLength(1);
      expect(reserved[0]!.returnRequestId).toBe(retB);
    }
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('13) late Stripe success after RELEASED versus capacity reuse', async () => {
    const { shipId, retA, retB, paymentTotalCents } = await seedShipmentPair(
      'latesucc',
      100,
    );
    const service = holds(sessionA);
    await reserveHold(sessionA, {
      returnRequestId: retA,
      orderShipmentId: shipId,
      returnedMerchandise: 60,
    });
    await service.claimLegacyStripeBeforeNetwork({ returnRequestId: retA });
    await service.recordLegacyStripeOutcome({
      returnRequestId: retA,
      outcome: 'FAILED_TERMINAL',
    });
    await service.requestAbandonment({ returnRequestId: retA });
    const released = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    expect(released.status).toBe(ShipmentRefundHoldStatus.RELEASED);

    const reused = await reserveHold(sessionA, {
      returnRequestId: retB,
      orderShipmentId: shipId,
      returnedMerchandise: 60,
    });
    expect(reused.status).toBe(ShipmentRefundHoldStatus.RESERVED);

    await expect(
      service.appendLegacyStripeEvidence({
        returnRequestId: retA,
        stripePaymentIntentId: `pi_latesucc_${run}`,
        stripeRefundId: `re_late_${run}`,
        stripeStatus: 'succeeded',
        source: 'RECOVERY_LIST',
        classification: 'SUCCEEDED',
        message: 'late success after release',
      }),
    ).rejects.toMatchObject({
      code: 'legacy_late_success_after_released',
    });

    const evidence = await sessionA.shipmentRefundHoldLegacyEvidence.findMany({
      where: { returnRequestId: retA },
      orderBy: { observedAt: 'asc' },
    });
    expect(evidence.length).toBeGreaterThanOrEqual(1);
    expect(
      evidence.some((e) => e.classification === 'LATE_SUCCESS_AFTER_RELEASED'),
    ).toBe(true);

    const holdA = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    expect(holdA.status).toBe(ShipmentRefundHoldStatus.RELEASED);
    const holdB = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retB },
    });
    expect(holdB.status).toBe(ShipmentRefundHoldStatus.RESERVED);
    expect(Number(holdB.amount)).toBe(60);

    const ship = await sessionA.orderShipment.findUniqueOrThrow({
      where: { id: shipId },
    });
    expect(dollarsToCentsExact(Number(ship.refundedAmount))).toBe(0);
    const rrA = await sessionA.returnRequest.findUniqueOrThrow({
      where: { id: retA },
    });
    expect(rrA.refundStatus).toBe(ReturnRefundStatus.PENDING);
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('14) dual-session LEGACY claim: only one fresh Stripe create eligible', async () => {
    const { shipId, retA, paymentTotalCents } = await seedShipmentPair(
      'dualclaim',
      44,
    );
    await reserveHold(sessionA, {
      returnRequestId: retA,
      orderShipmentId: shipId,
      returnedMerchandise: 44,
    });
    const a = holds(sessionA);
    const b = holds(sessionB);

    const [claimA, claimB] = await contendAfterGateRelease(
      'ReturnRequest',
      async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "ReturnRequest" WHERE id = ${retA} FOR UPDATE
        `;
      },
      () => a.claimLegacyStripeBeforeNetwork({ returnRequestId: retA }),
      () => b.claimLegacyStripeBeforeNetwork({ returnRequestId: retA }),
    );

    expect(claimA.status).toBe('fulfilled');
    expect(claimB.status).toBe('fulfilled');
    const fresh = [claimA, claimB].filter(
      (r) => r.status === 'fulfilled' && r.value.freshClaim,
    );
    const reuse = [claimA, claimB].filter(
      (r) => r.status === 'fulfilled' && !r.value.freshClaim,
    );
    expect(fresh).toHaveLength(1);
    expect(reuse).toHaveLength(1);

    const hold = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    expect(hold.status).toBe(ShipmentRefundHoldStatus.RESERVED);
    expect(hold.legacyStripeClaimedAt).toBeTruthy();
    expect(hold.legacyStripeOutcome).toBeNull();
    // Losing path is reuse-only: caller must list-reconcile, not create.
    expect(reuse[0]!.status === 'fulfilled' && reuse[0].value.freshClaim).toBe(
      false,
    );
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });

  it('15) dual-session LEGACY finalisation: one consume and one clawback', async () => {
    const { shipId, retA, paymentTotalCents } = await seedShipmentPair(
      'dualfin',
      22,
    );
    const clawback = createClawbackTracker();
    const setup = holds(sessionA, clawback.fn);
    await reserveHold(sessionA, {
      returnRequestId: retA,
      orderShipmentId: shipId,
      returnedMerchandise: 22,
    });
    await setup.claimLegacyStripeBeforeNetwork({ returnRequestId: retA });
    await setup.recordLegacyStripeOutcome({
      returnRequestId: retA,
      outcome: 'SUCCESS_PENDING_FINALIZE',
    });

    const a = holds(sessionA, clawback.fn);
    const b = holds(sessionB, clawback.fn);

    const [finA, finB] = await contendAfterGateRelease(
      'ReturnRequest',
      async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "ReturnRequest" WHERE id = ${retA} FOR UPDATE
        `;
      },
      () =>
        a.finalizeLegacySuccessfulRefund({
          returnRequestId: retA,
          actor,
        }),
      () =>
        b.finalizeLegacySuccessfulRefund({
          returnRequestId: retA,
          actor,
        }),
    );

    expect(finA.status).toBe('fulfilled');
    expect(finB.status).toBe('fulfilled');
    const values = [finA, finB]
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<{ idempotent: boolean }>).value);
    expect(values.filter((v) => !v.idempotent)).toHaveLength(1);
    expect(values.filter((v) => v.idempotent)).toHaveLength(1);

    const hold = await sessionA.shipmentRefundHold.findUniqueOrThrow({
      where: { returnRequestId: retA },
    });
    expect(hold.status).toBe(ShipmentRefundHoldStatus.CONSUMED);
    const ship = await sessionA.orderShipment.findUniqueOrThrow({
      where: { id: shipId },
    });
    expect(dollarsToCentsExact(Number(ship.refundedAmount))).toBe(2200);
    const rr = await sessionA.returnRequest.findUniqueOrThrow({
      where: { id: retA },
    });
    expect(rr.refundStatus).toBe(ReturnRefundStatus.ISSUED);
    expect(clawback.calls).toBe(1);
    await assertShipmentCapacityInvariantCents(
      sessionA,
      shipId,
      paymentTotalCents,
    );
  });
});
