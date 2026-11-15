/**
 * S2.4.4 / S2.4.10 — isolated PostgreSQL integration for legacy full-line clawback.
 *
 * Opt-in only (no DB connect without the flag):
 *   $env:S244_PG_TESTS = "1"
 *   $env:DATABASE_URL = "postgresql://winger:winger@127.0.0.1:5434/winger_s244?schema=public"
 *   npx jest --testPathPattern=legacy-clawback.postgres.integration --runInBand --no-coverage
 *
 * Does NOT call Stripe. Does NOT modify .env. Does NOT target 5433/winger.
 */
import {
  CommissionAllocationReason,
  CommissionCreditReason,
  CommissionRecognitionStatus,
  CommissionRemittanceMethod,
  CommissionRemittanceStatus,
  LegacyStripeOutcome,
  PrismaClient,
  RefundAttemptKind,
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
import { AuditService } from '../commissions/audit.service';
import { CommissionLedgerService } from '../commissions/commission-ledger.service';
import { CommissionsService } from '../commissions/commissions.service';
import { OrdersService } from './orders.service';
import { operationKeyForReturn } from './refund-attempt.types';
import { RefundAttemptService } from './refund-attempt.service';
import { ShipmentRefundHoldService } from './shipment-refund-hold.service';

type NonCardFinalizeParams = {
  returnRequestId: string;
  refundNote: string | null;
  user: AuthUser;
  orderItemId: string;
};

/**
 * Invoke the real OrdersService private method without constructing the full Nest graph.
 * Uses the prototype implementation with only prisma + shipmentRefundHolds wired.
 */
function bindFinalizeLegacyNonCardReturnIssued(
  prisma: PrismaClient,
  holds: ShipmentRefundHoldService,
): (params: NonCardFinalizeParams) => Promise<void> {
  const method = (
    OrdersService.prototype as unknown as {
      finalizeLegacyNonCardReturnIssued: (
        this: OrdersService,
        params: NonCardFinalizeParams,
      ) => Promise<void>;
    }
  ).finalizeLegacyNonCardReturnIssued;
  if (typeof method !== 'function') {
    throw new Error(
      'OrdersService.prototype.finalizeLegacyNonCardReturnIssued missing at runtime',
    );
  }
  const orders = Object.create(OrdersService.prototype) as OrdersService;
  Object.assign(orders, {
    prisma,
    shipmentRefundHolds: holds,
  });
  return method.bind(orders);
}

jest.setTimeout(120000);

const run = `s244${Date.now().toString(36)}`;
const optedIn = process.env.S244_PG_TESTS === '1';
const ISOLATED_HOST = '127.0.0.1';
const ISOLATED_PORT = '5434';
const ISOLATED_DB = 'winger_s244';
const ISOLATED_USER = 'winger';

function assertIsolatedDatabaseUrl(raw: string) {
  if (!raw) {
    throw new Error('DATABASE_URL is required for S2.4.10 isolated PG tests');
  }
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').split('?')[0];
  const user = decodeURIComponent(url.username);
  if (url.hostname !== ISOLATED_HOST) {
    throw new Error(`Refusing host ${url.hostname}; expected ${ISOLATED_HOST}`);
  }
  if (url.port !== ISOLATED_PORT) {
    throw new Error(`Refusing port ${url.port}; expected ${ISOLATED_PORT}`);
  }
  if (name !== ISOLATED_DB) {
    throw new Error(`Refusing database ${name}; expected ${ISOLATED_DB}`);
  }
  if (user && user !== ISOLATED_USER) {
    throw new Error(`Refusing user ${user}; expected ${ISOLATED_USER}`);
  }
  // Positive asserts above already reject winger / 5432 / 5433 / non-loopback.
}

function sessionUrl(raw: string, name: string) {
  const url = new URL(raw);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', name);
  return url.toString();
}

function money(value: unknown) {
  return Math.round(Number(value) * 100) / 100;
}

function sleep(ms: number) {
  return Promise.resolve().then(
    () => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

type Bundle = {
  ledger: CommissionLedgerService;
  commissions: CommissionsService;
  holds: ShipmentRefundHoldService;
  attempts: RefundAttemptService;
};

function bundle(db: PrismaClient): Bundle {
  const audit = new AuditService(db as never);
  const ledger = new CommissionLedgerService(db as never, audit, {} as never);
  const commissions = new CommissionsService(db as never, audit, ledger);
  const holds = new ShipmentRefundHoldService(db as never, ledger, commissions);
  // Stripe unused by applySuccessfulRefund for pre-succeeded fixtures.
  const attempts = new RefundAttemptService(
    db as never,
    {} as never,
    ledger,
    holds,
  );
  return { ledger, commissions, holds, attempts };
}

describe('S244 PG opt-in gate', () => {
  it('does not connect without S244_PG_TESTS=1', () => {
    if (!optedIn) {
      expect(process.env.S244_PG_TESTS).not.toBe('1');
      return;
    }
    expect(process.env.S244_PG_TESTS).toBe('1');
  });
});

const suite = optedIn ? describe : describe.skip;

type FinancialSnapshot = {
  oicStatus: string | null;
  clawbackRows: number;
  clawbackApplied: number;
  allocationReversals: number;
  applicationSourceReversals: number;
  clawbackCredits: number;
  creditAmount: number;
  activeAllocation: number;
  rrStatus: string | null;
  holdStatus: string | null;
  shipmentRefunded: number | null;
};

suite('S2.4.4 legacy clawback PostgreSQL isolation (S2.4.10)', () => {
  let rawUrl = '';
  let sessionA: PrismaClient;
  let sessionB: PrismaClient;
  let sessionGate: PrismaClient;
  let sessionObserver: PrismaClient;
  let svcA: Bundle;
  let svcB: Bundle;
  let admin: AuthUser;
  let customerId = '';
  let adminId = '';
  const supplierIds: string[] = [];
  const orderIds: string[] = [];
  const userIds: string[] = [];

  async function assertLiveConnectionIdentity(db: PrismaClient) {
    const rows = await db.$queryRaw<
      {
        db: string;
        usr: string;
        ver: string;
        port: number;
      }[]
    >`
      SELECT current_database() AS db,
             current_user AS usr,
             split_part(version(), ' ', 2) AS ver,
             inet_server_port() AS port
    `;
    const row = rows[0];
    expect(row.db).toBe(ISOLATED_DB);
    expect(row.usr).toBe(ISOLATED_USER);
    expect(String(row.ver).startsWith('18')).toBe(true);
    // Server listens on 5432 inside the container; host binding is asserted via URL.
    expect(Number(row.port)).toBe(5432);
    assertIsolatedDatabaseUrl(rawUrl);
  }

  beforeAll(async () => {
    rawUrl = process.env.DATABASE_URL ?? '';
    assertIsolatedDatabaseUrl(rawUrl);

    sessionA = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s244-a') } },
    });
    sessionB = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s244-b') } },
    });
    sessionGate = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s244-gate') } },
    });
    sessionObserver = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s244-obs') } },
    });
    await Promise.all([
      sessionA.$connect(),
      sessionB.$connect(),
      sessionGate.$connect(),
      sessionObserver.$connect(),
    ]);
    await assertLiveConnectionIdentity(sessionA);

    const migrationCount = await sessionA.$queryRaw<{ c: bigint }[]>`
      SELECT COUNT(*)::bigint AS c FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
    `;
    expect(Number(migrationCount[0].c)).toBe(38);

    adminId = `${run}-admin`;
    customerId = `${run}-customer`;
    userIds.push(adminId, customerId);
    admin = {
      sub: adminId,
      email: `${run}-admin@s244.invalid`,
      name: 'S244 admin',
      role: UserRole.ADMIN,
    };
    await sessionA.user.create({
      data: {
        id: adminId,
        email: admin.email,
        passwordHash: 'fixture-not-a-login',
        name: admin.name,
        role: UserRole.ADMIN,
      },
    });
    await sessionA.user.create({
      data: {
        id: customerId,
        email: `${run}-customer@s244.invalid`,
        passwordHash: 'fixture-not-a-login',
        name: 'S244 customer',
        role: UserRole.CUSTOMER,
      },
    });

    svcA = bundle(sessionA);
    svcB = bundle(sessionB);
  });

  afterAll(async () => {
    try {
      if (sessionA) {
        await cleanupRun(sessionA, {
          supplierIds,
          userIds,
          orderIds,
          customerId,
        });
      }
    } finally {
      await Promise.all([
        sessionA?.$disconnect(),
        sessionB?.$disconnect(),
        sessionGate?.$disconnect(),
        sessionObserver?.$disconnect(),
      ]);
    }
  });

  async function makeSupplier(label: string) {
    const supplierId = `${run}-sup-${label}`;
    await sessionA.supplier.create({
      data: {
        id: supplierId,
        name: `S244 FIXTURE ${label}`,
        verificationStatus: 'APPROVED',
      },
    });
    supplierIds.push(supplierId);
    await sessionA.product.create({
      data: {
        id: `${supplierId}-prod`,
        name: `S244 ${label}`,
        brand: 'S244',
        supplierId,
        supplierName: `S244 FIXTURE ${label}`,
        price: '100.00',
        imageUrl: 'https://example.invalid/s244.png',
        category: 's244-fixture',
      },
    });
    return supplierId;
  }

  async function seedLegacyLine(input: {
    label: string;
    supplierId: string;
    merchandise: number;
    commission: number;
    quantity?: number;
    refundDrive?: ReturnRefundDrive;
    refundStatus?: ReturnRefundStatus;
    withHold?: boolean;
    holdConsumed?: boolean;
    pendingFinalize?: boolean;
  }) {
    const qty = input.quantity ?? 1;
    const orderId = `${run}-ord-${input.label}`;
    const itemId = `${run}-item-${input.label}`;
    const shipId = `${run}-ship-${input.label}`;
    const retId = `${run}-ret-${input.label}`;
    const oicId = `${run}-oic-${input.label}`;
    orderIds.push(orderId);

    await sessionA.order.create({
      data: {
        id: orderId,
        displayId: `S244-${input.label}`,
        customerId,
        customerName: 'S244',
        customerEmail: `${run}-customer@s244.invalid`,
        subtotal: input.merchandise,
        total: input.merchandise,
        currency: 'usd',
        paymentMode: 'lipa',
        paymentStatus: 'PAID',
        status: 'DELIVERED',
        stripePaymentIntentId: `pi_${input.label}_${run}`,
      } as never,
    });
    await sessionA.orderItem.create({
      data: {
        id: itemId,
        orderId,
        productId: `${input.supplierId}-prod`,
        productName: 'S244 Widget',
        supplierId: input.supplierId,
        supplierName: input.supplierId,
        unitPrice: money(input.merchandise / qty),
        quantity: qty,
        lineTotal: input.merchandise,
        status: 'DELIVERED',
      } as never,
    });
    await sessionA.orderShipment.create({
      data: {
        id: shipId,
        orderId,
        supplierId: input.supplierId,
        supplierName: input.supplierId,
        merchandise: input.merchandise,
        deliveryFee: 0,
        merchandiseTax: 0,
        deliveryTax: 0,
        paymentMerchandise: input.merchandise,
        paymentDelivery: 0,
        paymentTax: 0,
        refundedAmount: 0,
      } as never,
    });
    await sessionA.returnRequest.create({
      data: {
        id: retId,
        orderId,
        orderItemId: itemId,
        customerId,
        reason: 's244-fixture',
        quantity: qty,
        status: ReturnRequestStatus.APPROVED,
        refundStatus: input.refundStatus ?? ReturnRefundStatus.PENDING,
        refundDrive: input.refundDrive ?? ReturnRefundDrive.LEGACY,
        refundedAt:
          (input.refundStatus ?? ReturnRefundStatus.PENDING) ===
          ReturnRefundStatus.ISSUED
            ? new Date('2026-01-15T00:00:00.000Z')
            : null,
      } as never,
    });
    await sessionA.orderItemCommission.create({
      data: {
        id: oicId,
        orderItemId: itemId,
        ratePercent: '10.00',
        commissionBase: input.merchandise,
        commissionAmount: input.commission,
        currency: 'USD',
        status: CommissionRecognitionStatus.SETTLEABLE,
        // eligibleLines() only sweeps cod/lipa settleable cash lines.
        paymentMode: 'lipa',
        isDemo: false,
        settleableAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });

    let holdId: string | null = null;
    if (input.withHold) {
      await sessionA.$transaction(async (tx) => {
        await svcA.holds.lockReturnRequest(tx, retId);
        const view = await svcA.holds.reserveInTransaction(tx, {
          returnRequestId: retId,
          orderShipmentId: shipId,
          supplierId: input.supplierId,
          currency: 'usd',
          returnedMerchandise: input.merchandise,
          includeDelivery: false,
          siblingHadLiveLine: true,
        });
        holdId = view.id;
      });
      if (input.pendingFinalize) {
        await svcA.holds.claimLegacyStripeBeforeNetwork({
          returnRequestId: retId,
        });
        await svcA.holds.recordLegacyStripeOutcome({
          returnRequestId: retId,
          outcome: 'SUCCESS_PENDING_FINALIZE',
        });
      }
      if (input.holdConsumed) {
        await sessionA.shipmentRefundHold.update({
          where: { returnRequestId: retId },
          data: {
            status: ShipmentRefundHoldStatus.CONSUMED,
            legacyStripeClaimedAt: new Date('2026-01-14T00:00:00.000Z'),
            legacyStripeOutcome: LegacyStripeOutcome.SUCCESS_PENDING_FINALIZE,
          },
        });
        await sessionA.orderShipment.update({
          where: { id: shipId },
          data: { refundedAmount: input.merchandise },
        });
      }
    }

    return { orderId, itemId, shipId, retId, oicId, holdId };
  }

  async function snapshotFinancials(input: {
    oicId: string;
    retId: string;
    supplierId: string;
  }): Promise<FinancialSnapshot> {
    const oic = await sessionA.orderItemCommission.findUnique({
      where: { id: input.oicId },
    });
    const clawbacks = await sessionA.commissionClawback.findMany({
      where: { orderItemCommissionId: input.oicId },
    });
    const allocationReversals =
      await sessionA.commissionAllocationReversal.count({
        where: {
          allocation: { remittance: { supplierId: input.supplierId } },
        },
      });
    const applicationSourceReversals =
      await sessionA.commissionCreditApplicationSourceReversal.count({
        where: {
          applicationSource: {
            creditSource: { credit: { supplierId: input.supplierId } },
          },
        },
      });
    const credits = await sessionA.commissionCredit.findMany({
      where: {
        supplierId: input.supplierId,
        reason: CommissionCreditReason.CLAWBACK_AFTER_COLLECTION,
      },
    });
    const allocations = await sessionA.commissionAllocation.findMany({
      where: { remittance: { supplierId: input.supplierId } },
      include: { reversals: true },
    });
    const activeAllocation = money(
      allocations.reduce(
        (sum, row) =>
          sum +
          money(row.amountUsd) -
          row.reversals.reduce(
            (inner, rev) => inner + money(rev.amountUsd),
            0,
          ),
        0,
      ),
    );
    const rr = await sessionA.returnRequest.findUnique({
      where: { id: input.retId },
    });
    const hold = await sessionA.shipmentRefundHold.findUnique({
      where: { returnRequestId: input.retId },
    });
    const ship = hold
      ? await sessionA.orderShipment.findUnique({
          where: { id: hold.orderShipmentId },
        })
      : null;
    return {
      oicStatus: oic?.status ?? null,
      clawbackRows: clawbacks.length,
      clawbackApplied: clawbacks.filter((row) => row.appliedAt != null).length,
      allocationReversals,
      applicationSourceReversals,
      clawbackCredits: credits.length,
      creditAmount: money(
        credits.reduce((sum, row) => sum + money(row.amountUsd), 0),
      ),
      activeAllocation,
      rrStatus: rr?.refundStatus ?? null,
      holdStatus: hold?.status ?? null,
      shipmentRefunded: ship ? money(ship.refundedAmount) : null,
    };
  }

  async function seedVerifiedAllocation(input: {
    label: string;
    supplierId: string;
    oicId: string;
    amount: number;
  }) {
    const remittanceId = `${run}-rem-${input.label}`;
    await sessionA.commissionRemittance.create({
      data: {
        id: remittanceId,
        supplierId: input.supplierId,
        method: CommissionRemittanceMethod.WINGER_LIPA,
        status: CommissionRemittanceStatus.VERIFIED,
        claimedAmount: input.amount.toFixed(2),
        claimedCurrency: 'USD',
        verifiedAmountUsd: input.amount.toFixed(2),
        verifiedAt: new Date('2026-03-01T00:00:00.000Z'),
        referenceRaw: remittanceId,
        referenceNormalized: remittanceId.toUpperCase(),
        provider: 'TEST',
        merchantAccountKey: `${run}-account`,
        autoApply: true,
        submittedByUserId: adminId,
      },
    });
    await svcA.ledger.sweepSupplier(input.supplierId);
    const alloc = await sessionA.commissionAllocation.findFirst({
      where: {
        remittanceId,
        orderItemCommissionId: input.oicId,
      },
    });
    expect(alloc).toBeTruthy();
    expect(money(alloc!.amountUsd)).toBe(money(input.amount));
    return { remittanceId, allocationId: alloc!.id };
  }

  it('A) atomic rollback leaves no partial financial or finalization state', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('a');
    const line = await seedLegacyLine({
      label: 'a',
      supplierId,
      merchandise: 100,
      commission: 10,
      withHold: true,
      pendingFinalize: true,
    });
    await seedVerifiedAllocation({
      label: 'a',
      supplierId,
      oicId: line.oicId,
      amount: 10,
    });
    const before = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    expect(before.oicStatus).toBe(CommissionRecognitionStatus.SETTLEABLE);
    expect(before.rrStatus).toBe(ReturnRefundStatus.PENDING);
    expect(before.holdStatus).toBe(ShipmentRefundHoldStatus.RESERVED);

    await expect(
      sessionA.$transaction(async (tx) => {
        await svcA.holds.lockReturnRequest(tx, line.retId);
        const hold = await tx.shipmentRefundHold.findUniqueOrThrow({
          where: { returnRequestId: line.retId },
        });
        await svcA.holds.lockShipment(tx, hold.orderShipmentId);
        await svcA.holds.lockHold(tx, hold.id);
        await tx.orderShipment.update({
          where: { id: hold.orderShipmentId },
          data: { refundedAmount: '100.00' },
        });
        await tx.shipmentRefundHold.update({
          where: { id: hold.id },
          data: { status: ShipmentRefundHoldStatus.CONSUMED },
        });
        const commission = await svcA.holds.completeLegacyReturnCommissionInTx(
          tx,
          {
            returnRequestId: line.retId,
            orderItemId: line.itemId,
            actor: admin,
          },
        );
        expect(commission.fullLineApplied).toBe(true);
        await tx.returnRequest.update({
          where: { id: line.retId },
          data: {
            refundStatus: ReturnRefundStatus.ISSUED,
            refundedAt: new Date(),
          },
        });
        throw new Error('s244-controlled-rollback');
      }),
    ).rejects.toThrow('s244-controlled-rollback');

    const after = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    expect(after).toEqual(before);
    expect(after.oicStatus).toBe(CommissionRecognitionStatus.SETTLEABLE);
    expect(after.clawbackCredits).toBe(0);
    expect(after.allocationReversals).toBe(0);
    expect(after.rrStatus).toBe(ReturnRefundStatus.PENDING);
    expect(after.holdStatus).toBe(ShipmentRefundHoldStatus.RESERVED);
  });

  it('H) real finalizeLegacySuccessfulRefund rolls back after clawback+ISSUED then retries once', async () => {
    /**
     * Invokes the real entry point. Failure is injected via a one-shot spy on the
     * Prisma client's $transaction: the production callback runs to completion
     * (shipment/hold/clawback/ISSUED writes), then throws before commit.
     * If clawback committed on an independent transaction, after-state would diverge.
     */
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('h');
    const line = await seedLegacyLine({
      label: 'h',
      supplierId,
      merchandise: 90,
      commission: 9,
      withHold: true,
      pendingFinalize: true,
    });
    await seedVerifiedAllocation({
      label: 'h',
      supplierId,
      oicId: line.oicId,
      amount: 9,
    });
    const before = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    expect(before.oicStatus).toBe(CommissionRecognitionStatus.SETTLEABLE);
    expect(before.rrStatus).toBe(ReturnRefundStatus.PENDING);
    expect(before.holdStatus).toBe(ShipmentRefundHoldStatus.RESERVED);
    expect(before.clawbackCredits).toBe(0);
    expect(before.allocationReversals).toBe(0);

    let injectRollback = false;
    const originalTransaction = sessionA.$transaction.bind(sessionA);
    const txSpy = jest
      .spyOn(sessionA, '$transaction')
      .mockImplementation(((arg1: unknown, arg2?: unknown) => {
        if (typeof arg1 !== 'function' || !injectRollback) {
          return originalTransaction(arg1 as never, arg2 as never);
        }
        injectRollback = false;
        return originalTransaction(async (tx) => {
          const result = await (
            arg1 as (client: typeof tx) => Promise<unknown>
          )(tx);

          // Still inside the open txn: prove clawback + finalization writes ran.
          const oic = await tx.orderItemCommission.findUniqueOrThrow({
            where: { id: line.oicId },
          });
          const rr = await tx.returnRequest.findUniqueOrThrow({
            where: { id: line.retId },
          });
          const hold = await tx.shipmentRefundHold.findUniqueOrThrow({
            where: { returnRequestId: line.retId },
          });
          const ship = await tx.orderShipment.findUniqueOrThrow({
            where: { id: line.shipId },
          });
          const credits = await tx.commissionCredit.count({
            where: {
              supplierId,
              reason: CommissionCreditReason.CLAWBACK_AFTER_COLLECTION,
            },
          });
          const reversals = await tx.commissionAllocationReversal.count({
            where: {
              allocation: { remittance: { supplierId } },
            },
          });
          expect(oic.status).toBe(CommissionRecognitionStatus.CLAWED_BACK);
          expect(rr.refundStatus).toBe(ReturnRefundStatus.ISSUED);
          expect(hold.status).toBe(ShipmentRefundHoldStatus.CONSUMED);
          expect(money(ship.refundedAmount)).toBe(90);
          expect(credits).toBe(1);
          expect(reversals).toBe(1);
          expect(result).toEqual(
            expect.objectContaining({
              idempotent: false,
              legacyClawback: true,
            }),
          );

          throw new Error('s244-finalize-entry-rollback');
        }, arg2 as never);
      }) as typeof sessionA.$transaction);

    try {
      injectRollback = true;
      await expect(
        svcA.holds.finalizeLegacySuccessfulRefund({
          returnRequestId: line.retId,
          actor: admin,
        }),
      ).rejects.toThrow('s244-finalize-entry-rollback');
      expect(injectRollback).toBe(false);

      const afterRollback = await snapshotFinancials({
        oicId: line.oicId,
        retId: line.retId,
        supplierId,
      });
      expect(afterRollback).toEqual(before);
      expect(afterRollback.oicStatus).toBe(
        CommissionRecognitionStatus.SETTLEABLE,
      );
      expect(afterRollback.clawbackCredits).toBe(0);
      expect(afterRollback.allocationReversals).toBe(0);
      expect(afterRollback.rrStatus).toBe(ReturnRefundStatus.PENDING);
      expect(afterRollback.holdStatus).toBe(ShipmentRefundHoldStatus.RESERVED);
      expect(afterRollback.shipmentRefunded).toBe(0);

      const first = await svcA.holds.finalizeLegacySuccessfulRefund({
        returnRequestId: line.retId,
        actor: admin,
      });
      expect(first.idempotent).toBe(false);
      expect(first.legacyClawback).toBe(true);

      const committed = await snapshotFinancials({
        oicId: line.oicId,
        retId: line.retId,
        supplierId,
      });
      expect(committed.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
      expect(committed.clawbackCredits).toBe(1);
      expect(committed.creditAmount).toBe(9);
      expect(committed.allocationReversals).toBe(1);
      expect(committed.activeAllocation).toBe(0);
      expect(committed.rrStatus).toBe(ReturnRefundStatus.ISSUED);
      expect(committed.holdStatus).toBe(ShipmentRefundHoldStatus.CONSUMED);
      expect(committed.shipmentRefunded).toBe(90);

      const repair = await svcA.holds.finalizeLegacySuccessfulRefund({
        returnRequestId: line.retId,
        actor: admin,
      });
      expect(repair.idempotent).toBe(true);
      expect(repair.legacyClawback).toBe(false);
      expect(
        await snapshotFinancials({
          oicId: line.oicId,
          retId: line.retId,
          supplierId,
        }),
      ).toEqual(committed);
    } finally {
      txSpy.mockRestore();
    }
  });

  it('B) concurrent full-line clawbacks persist exactly one clawback', async () => {
    /**
     * Proves OIC FOR NO KEY UPDATE inside clawbackForOrderItem — not RR serialization.
     * Production finalize usually holds RR first; that lock is intentionally omitted
     * here so both clients contend only on the same OrderItemCommission row.
     */
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('b');
    const line = await seedLegacyLine({
      label: 'b',
      supplierId,
      merchandise: 80,
      commission: 8,
    });
    await seedVerifiedAllocation({
      label: 'b',
      supplierId,
      oicId: line.oicId,
      amount: 8,
    });
    const before = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });

    let gateLocked = false;
    let releaseGate = () => {};
    const gateOpen = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateHold = sessionGate.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "OrderItemCommission" WHERE id = ${line.oicId} FOR NO KEY UPDATE
        `;
        gateLocked = true;
        await gateOpen;
      },
      { timeout: 30000 },
    );
    while (!gateLocked) await sleep(20);

    // No shared RR lock — both racers enter clawbackForOrderItem and block on OIC.
    const raceA = sessionA.$transaction(
      async (tx) =>
        svcA.commissions.clawbackForOrderItem({
          orderItemId: line.itemId,
          actor: admin,
          returnRequestId: line.retId,
          tx,
        }),
      { timeout: 30000 },
    );
    const raceB = sessionB.$transaction(
      async (tx) =>
        svcB.commissions.clawbackForOrderItem({
          orderItemId: line.itemId,
          actor: admin,
          returnRequestId: line.retId,
          tx,
        }),
      { timeout: 30000 },
    );

    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) {
      const rows = await sessionObserver.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(*)::bigint AS n
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE NOT l.granted
          AND a.application_name IN ('winger-s244-a', 'winger-s244-b')
      `;
      if (Number(rows[0].n) >= 2) {
        blocked = true;
        break;
      }
      await sleep(50);
    }
    expect(blocked).toBe(true);
    releaseGate();
    await gateHold;
    const settled = await Promise.allSettled([raceA, raceB]);

    const fulfilled = settled.filter((row) => row.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);
    const results = fulfilled.map(
      (row) =>
        (row as PromiseFulfilledResult<{ clawedBack: boolean; reason: string }>)
          .value,
    );
    expect(results.filter((row) => row.clawedBack).length).toBe(1);
    expect(results.filter((row) => !row.clawedBack).length).toBe(1);
    expect(
      results.some(
        (row) => !row.clawedBack && row.reason === 'already_clawed_back',
      ),
    ).toBe(true);

    const after = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    expect(after.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
    expect(after.clawbackCredits).toBe(1);
    expect(after.creditAmount).toBe(8);
    expect(after.allocationReversals).toBe(1);
    expect(after.activeAllocation).toBe(0);
    expect(after.clawbackCredits).toBe(before.clawbackCredits + 1);
  });

  it('I) sweep FK insert coexists with OIC FOR NO KEY UPDATE; clawback once', async () => {
    /**
     * Old FOR UPDATE on OIC conflicts with FK FOR KEY SHARE taken when sweep inserts
     * CommissionAllocation referencing that OIC while holding supplier credits.
     * Gate holds the production clawback lock mode; real sweepSupplier must allocate
     * while that lock is still held (proves KEY SHARE compatibility).
     */
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('i');
    const line = await seedLegacyLine({
      label: 'i',
      supplierId,
      merchandise: 100,
      commission: 10,
    });

    // Existing credit rows so clawback's lockSupplierCredits is non-empty (realistic).
    const anchorItemId = `${run}-item-i-anchor`;
    const anchorOicId = `${run}-oic-i-anchor`;
    await sessionA.orderItem.create({
      data: {
        id: anchorItemId,
        orderId: line.orderId,
        productId: `${supplierId}-prod`,
        productName: 'S244 Anchor I',
        supplierId,
        supplierName: supplierId,
        unitPrice: '10.00',
        quantity: 1,
        lineTotal: '10.00',
        status: 'PROCESSING',
      } as never,
    });
    await sessionA.orderItemCommission.create({
      data: {
        id: anchorOicId,
        orderItemId: anchorItemId,
        ratePercent: '10.00',
        commissionBase: '5.00',
        commissionAmount: '5.00',
        currency: 'USD',
        status: CommissionRecognitionStatus.RECOGNIZED,
        paymentMode: 'lipa',
        isDemo: false,
      },
    });
    const fundingRemId = `${run}-rem-i-funding`;
    const fundingAllocId = `${run}-alloc-i-funding`;
    await sessionA.commissionRemittance.create({
      data: {
        id: fundingRemId,
        supplierId,
        method: CommissionRemittanceMethod.WINGER_LIPA,
        status: CommissionRemittanceStatus.VERIFIED,
        claimedAmount: '5.00',
        claimedCurrency: 'USD',
        verifiedAmountUsd: '5.00',
        verifiedAt: new Date('2026-03-01T00:00:00.000Z'),
        referenceRaw: fundingRemId,
        referenceNormalized: fundingRemId.toUpperCase(),
        provider: 'TEST',
        merchantAccountKey: `${run}-account`,
        autoApply: false,
        submittedByUserId: adminId,
      },
    });
    await sessionA.commissionAllocation.create({
      data: {
        id: fundingAllocId,
        remittanceId: fundingRemId,
        orderItemCommissionId: anchorOicId,
        amountUsd: '5.00',
        reason: CommissionAllocationReason.MANUAL,
        actorUserId: adminId,
        actorType: 'USER',
      },
    });
    await sessionA.commissionCredit.create({
      data: {
        id: `${run}-credit-i`,
        supplierId,
        orderItemCommissionId: line.oicId,
        amountUsd: '5.00',
        reason: CommissionCreditReason.CLAWBACK_AFTER_COLLECTION,
        sourceEventKey: `${run}-credit-key-i`,
        actorUserId: adminId,
        sources: {
          create: [
            {
              id: `${run}-csrc-i`,
              allocationId: fundingAllocId,
              amountUsd: '5.00',
            },
          ],
        },
      },
    });
    // Apply credit now so remaining is 0 but credit rows still exist for lockSupplierCredits.
    await svcA.ledger.sweepSupplier(supplierId);
    expect(await activeAppliedCredit(sessionA, `${run}-credit-i`)).toBe(5);

    // Unallocated verified cash for the payable OIC (sweep will insert FK to OIC).
    const sweepRemId = `${run}-rem-i-sweep`;
    await sessionA.commissionRemittance.create({
      data: {
        id: sweepRemId,
        supplierId,
        method: CommissionRemittanceMethod.WINGER_LIPA,
        status: CommissionRemittanceStatus.VERIFIED,
        claimedAmount: '10.00',
        claimedCurrency: 'USD',
        verifiedAmountUsd: '10.00',
        verifiedAt: new Date('2026-03-02T00:00:00.000Z'),
        referenceRaw: sweepRemId,
        referenceNormalized: sweepRemId.toUpperCase(),
        provider: 'TEST',
        merchantAccountKey: `${run}-account`,
        autoApply: true,
        submittedByUserId: adminId,
      },
    });
    expect(
      await sessionA.commissionAllocation.count({
        where: { remittanceId: sweepRemId },
      }),
    ).toBe(0);

    let gateLocked = false;
    let releaseGate = () => {};
    const gateOpen = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const gateHold = sessionGate.$transaction(
      async (tx) => {
        // Same lock mode as clawbackForOrderItem after S2.4.16.
        await tx.$queryRaw`
          SELECT id FROM "OrderItemCommission" WHERE id = ${line.oicId} FOR NO KEY UPDATE
        `;
        gateLocked = true;
        await gateOpen;
      },
      { timeout: 30000 },
    );
    while (!gateLocked) await sleep(20);

    const sweepPromise = svcB.ledger.sweepSupplier(supplierId);

    let allocatedWhileHeld = false;
    for (let i = 0; i < 100 && !allocatedWhileHeld; i++) {
      const n = await sessionObserver.commissionAllocation.count({
        where: { remittanceId: sweepRemId },
      });
      if (n >= 1) {
        allocatedWhileHeld = true;
        break;
      }
      await sleep(50);
    }
    expect(allocatedWhileHeld).toBe(true);

    releaseGate();
    await gateHold;
    await withTimeout(
      sweepPromise,
      25000,
      's244-sweep-timeout-under-oic-lock',
    );
    expect(
      await sessionA.commissionAllocation.count({
        where: { remittanceId: sweepRemId },
      }),
    ).toBe(1);

    // Concurrent clawback + re-sweep must not deadlock (bounded).
    await withTimeout(
      Promise.all([
        svcA.commissions.clawbackForOrderItem({
          orderItemId: line.itemId,
          actor: admin,
          returnRequestId: line.retId,
        }),
        svcB.ledger.sweepSupplier(supplierId),
      ]),
      25000,
      's244-clawback-sweep-deadlock-timeout',
    );

    const after = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    expect(after.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
    // Credit covered $5; sweep cash-allocated the remaining $5 against the $10 OIC.
    const sweepAlloc = await sessionA.commissionAllocation.findMany({
      where: { remittanceId: sweepRemId },
      include: { reversals: true },
    });
    expect(sweepAlloc).toHaveLength(1);
    expect(money(sweepAlloc[0]!.amountUsd)).toBe(5);
    expect(
      money(
        money(sweepAlloc[0]!.amountUsd) -
          sweepAlloc[0]!.reversals.reduce(
            (sum, row) => sum + money(row.amountUsd),
            0,
          ),
      ),
    ).toBe(0);
    expect(sweepAlloc[0]!.reversals).toHaveLength(1);
    expect(after.applicationSourceReversals).toBeGreaterThan(0);
    expect(await activeAppliedCredit(sessionA, `${run}-credit-i`)).toBe(0);
    // Exactly one full-line clawback cash-restoration credit ($5 swept).
    const clawCredits = await sessionA.commissionCredit.findMany({
      where: {
        supplierId,
        orderItemCommissionId: line.oicId,
        reason: CommissionCreditReason.CLAWBACK_AFTER_COLLECTION,
        sourceEventKey: { startsWith: 'clawback:' },
      },
    });
    expect(clawCredits).toHaveLength(1);
    expect(money(clawCredits[0]!.amountUsd)).toBe(5);
  });

  it('C) retry after rollback completes with exactly one full-line clawback', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('c');
    const line = await seedLegacyLine({
      label: 'c',
      supplierId,
      merchandise: 50,
      commission: 5,
      withHold: true,
      pendingFinalize: true,
    });
    await seedVerifiedAllocation({
      label: 'c',
      supplierId,
      oicId: line.oicId,
      amount: 5,
    });
    const before = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });

    await expect(
      sessionA.$transaction(async (tx) => {
        const commission = await svcA.holds.completeLegacyReturnCommissionInTx(
          tx,
          {
            returnRequestId: line.retId,
            orderItemId: line.itemId,
            actor: admin,
          },
        );
        expect(commission.fullLineApplied).toBe(true);
        throw new Error('s244-retry-rollback');
      }),
    ).rejects.toThrow('s244-retry-rollback');
    expect(
      await snapshotFinancials({
        oicId: line.oicId,
        retId: line.retId,
        supplierId,
      }),
    ).toEqual(before);

    const result = await svcA.holds.finalizeLegacySuccessfulRefund({
      returnRequestId: line.retId,
      actor: admin,
    });
    expect(result.idempotent).toBe(false);
    expect(result.legacyClawback).toBe(true);

    const after = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    expect(after.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
    expect(after.clawbackCredits).toBe(1);
    expect(after.creditAmount).toBe(5);
    expect(after.allocationReversals).toBe(1);
    expect(after.rrStatus).toBe(ReturnRefundStatus.ISSUED);
    expect(after.holdStatus).toBe(ShipmentRefundHoldStatus.CONSUMED);
    expect(after.shipmentRefunded).toBe(50);

    const repair = await svcA.holds.finalizeLegacySuccessfulRefund({
      returnRequestId: line.retId,
      actor: admin,
    });
    expect(repair.idempotent).toBe(true);
    expect(repair.legacyClawback).toBe(false);
    expect(
      await snapshotFinancials({
        oicId: line.oicId,
        retId: line.retId,
        supplierId,
      }),
    ).toEqual(after);
  });

  it('D) idempotent card repair does not duplicate full-line clawback', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('d');
    const line = await seedLegacyLine({
      label: 'd',
      supplierId,
      merchandise: 70,
      commission: 7,
      refundStatus: ReturnRefundStatus.ISSUED,
      withHold: true,
      holdConsumed: true,
    });
    await seedVerifiedAllocation({
      label: 'd',
      supplierId,
      oicId: line.oicId,
      amount: 7,
    });
    const before = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    expect(before.oicStatus).toBe(CommissionRecognitionStatus.SETTLEABLE);
    expect(before.rrStatus).toBe(ReturnRefundStatus.ISSUED);
    expect(before.holdStatus).toBe(ShipmentRefundHoldStatus.CONSUMED);

    const first = await svcA.holds.finalizeLegacySuccessfulRefund({
      returnRequestId: line.retId,
      actor: admin,
    });
    expect(first.idempotent).toBe(true);
    expect(first.legacyClawback).toBe(true);
    const mid = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    expect(mid.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
    expect(mid.clawbackCredits).toBe(1);
    expect(mid.creditAmount).toBe(7);
    expect(mid.allocationReversals).toBe(1);

    const second = await svcA.holds.finalizeLegacySuccessfulRefund({
      returnRequestId: line.retId,
      actor: admin,
    });
    expect(second.idempotent).toBe(true);
    expect(second.legacyClawback).toBe(false);
    expect(
      await snapshotFinancials({
        oicId: line.oicId,
        retId: line.retId,
        supplierId,
      }),
    ).toEqual(mid);
  });

  it('E1) real finalizeLegacyNonCardReturnIssued repairs already-ISSUED once', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const finalizeNonCard = bindFinalizeLegacyNonCardReturnIssued(
      sessionA,
      svcA.holds,
    );
    const supplierId = await makeSupplier('e1');
    const line = await seedLegacyLine({
      label: 'e1',
      supplierId,
      merchandise: 40,
      commission: 4,
      refundDrive: ReturnRefundDrive.LEGACY,
      refundStatus: ReturnRefundStatus.ISSUED,
      withHold: false,
    });
    await seedVerifiedAllocation({
      label: 'e1',
      supplierId,
      oicId: line.oicId,
      amount: 4,
    });
    expect(
      await sessionA.shipmentRefundHold.count({
        where: { returnRequestId: line.retId },
      }),
    ).toBe(0);

    await finalizeNonCard({
      returnRequestId: line.retId,
      refundNote: null,
      user: admin,
      orderItemId: line.itemId,
    });
    const mid = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    expect(mid.rrStatus).toBe(ReturnRefundStatus.ISSUED);
    expect(mid.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
    expect(mid.clawbackCredits).toBe(1);
    expect(mid.creditAmount).toBe(4);
    expect(mid.allocationReversals).toBe(1);
    expect(mid.activeAllocation).toBe(0);
    expect(mid.holdStatus).toBeNull();

    await finalizeNonCard({
      returnRequestId: line.retId,
      refundNote: 'retry-should-noop',
      user: admin,
      orderItemId: line.itemId,
    });
    expect(
      await snapshotFinancials({
        oicId: line.oicId,
        retId: line.retId,
        supplierId,
      }),
    ).toEqual(mid);
  });

  it('E2) real finalizeLegacyNonCardReturnIssued first-issues with in-txn clawback', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const finalizeNonCard = bindFinalizeLegacyNonCardReturnIssued(
      sessionA,
      svcA.holds,
    );
    const supplierId = await makeSupplier('e2');
    const line = await seedLegacyLine({
      label: 'e2',
      supplierId,
      merchandise: 55,
      commission: 5.5,
      refundDrive: ReturnRefundDrive.LEGACY,
      refundStatus: ReturnRefundStatus.PENDING,
      withHold: false,
    });
    await seedVerifiedAllocation({
      label: 'e2',
      supplierId,
      oicId: line.oicId,
      amount: 5.5,
    });
    const before = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    expect(before.rrStatus).toBe(ReturnRefundStatus.PENDING);
    expect(before.oicStatus).toBe(CommissionRecognitionStatus.SETTLEABLE);

    await finalizeNonCard({
      returnRequestId: line.retId,
      refundNote: 'non-card issued',
      user: admin,
      orderItemId: line.itemId,
    });

    const after = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    const rr = await sessionA.returnRequest.findUniqueOrThrow({
      where: { id: line.retId },
    });
    expect(after.rrStatus).toBe(ReturnRefundStatus.ISSUED);
    expect(rr.refundNote).toBe('non-card issued');
    expect(rr.refundedAt).not.toBeNull();
    expect(after.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
    expect(after.clawbackCredits).toBe(1);
    expect(after.creditAmount).toBe(5.5);
    expect(after.allocationReversals).toBe(1);
    expect(after.activeAllocation).toBe(0);
    expect(after.holdStatus).toBeNull();
  });

  it('E3) real finalizeLegacyNonCardReturnIssued rolls back then retries once', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const finalizeNonCard = bindFinalizeLegacyNonCardReturnIssued(
      sessionA,
      svcA.holds,
    );
    const supplierId = await makeSupplier('e3');
    const line = await seedLegacyLine({
      label: 'e3',
      supplierId,
      merchandise: 60,
      commission: 6,
      refundDrive: ReturnRefundDrive.LEGACY,
      refundStatus: ReturnRefundStatus.PENDING,
      withHold: false,
    });
    await seedVerifiedAllocation({
      label: 'e3',
      supplierId,
      oicId: line.oicId,
      amount: 6,
    });
    const before = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });

    let injectRollback = false;
    const originalTransaction = sessionA.$transaction.bind(sessionA);
    const txSpy = jest
      .spyOn(sessionA, '$transaction')
      .mockImplementation(((arg1: unknown, arg2?: unknown) => {
        if (typeof arg1 !== 'function' || !injectRollback) {
          return originalTransaction(arg1 as never, arg2 as never);
        }
        injectRollback = false;
        return originalTransaction(async (tx) => {
          await (arg1 as (client: typeof tx) => Promise<unknown>)(tx);

          const oic = await tx.orderItemCommission.findUniqueOrThrow({
            where: { id: line.oicId },
          });
          const rr = await tx.returnRequest.findUniqueOrThrow({
            where: { id: line.retId },
          });
          const credits = await tx.commissionCredit.count({
            where: {
              supplierId,
              reason: CommissionCreditReason.CLAWBACK_AFTER_COLLECTION,
            },
          });
          const reversals = await tx.commissionAllocationReversal.count({
            where: { allocation: { remittance: { supplierId } } },
          });
          expect(oic.status).toBe(CommissionRecognitionStatus.CLAWED_BACK);
          expect(rr.refundStatus).toBe(ReturnRefundStatus.ISSUED);
          expect(credits).toBe(1);
          expect(reversals).toBe(1);

          throw new Error('s244-noncard-entry-rollback');
        }, arg2 as never);
      }) as typeof sessionA.$transaction);

    try {
      injectRollback = true;
      await expect(
        finalizeNonCard({
          returnRequestId: line.retId,
          refundNote: 'should-roll-back',
          user: admin,
          orderItemId: line.itemId,
        }),
      ).rejects.toThrow('s244-noncard-entry-rollback');
      expect(injectRollback).toBe(false);

      const afterRollback = await snapshotFinancials({
        oicId: line.oicId,
        retId: line.retId,
        supplierId,
      });
      expect(afterRollback).toEqual(before);
      expect(afterRollback.rrStatus).toBe(ReturnRefundStatus.PENDING);
      expect(afterRollback.oicStatus).toBe(
        CommissionRecognitionStatus.SETTLEABLE,
      );
      expect(afterRollback.clawbackCredits).toBe(0);
      expect(afterRollback.allocationReversals).toBe(0);

      await finalizeNonCard({
        returnRequestId: line.retId,
        refundNote: 'issued-after-retry',
        user: admin,
        orderItemId: line.itemId,
      });
      const committed = await snapshotFinancials({
        oicId: line.oicId,
        retId: line.retId,
        supplierId,
      });
      expect(committed.rrStatus).toBe(ReturnRefundStatus.ISSUED);
      expect(committed.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
      expect(committed.clawbackCredits).toBe(1);
      expect(committed.creditAmount).toBe(6);
      expect(committed.allocationReversals).toBe(1);
      expect(committed.activeAllocation).toBe(0);

      await finalizeNonCard({
        returnRequestId: line.retId,
        refundNote: 'idempotent',
        user: admin,
        orderItemId: line.itemId,
      });
      expect(
        await snapshotFinancials({
          oicId: line.oicId,
          retId: line.retId,
          supplierId,
        }),
      ).toEqual(committed);
    } finally {
      txSpy.mockRestore();
    }
  });

  it('F) ATTEMPT apply path applies proportional reservation and skips full-line clawback', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('f');
    // Qty 2 line; return qty 1 → $50 merchandise / $5 commission reservation.
    const line = await seedLegacyLine({
      label: 'f',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 2,
      refundDrive: ReturnRefundDrive.ATTEMPT,
    });
    await seedVerifiedAllocation({
      label: 'f',
      supplierId,
      oicId: line.oicId,
      amount: 10,
    });

    const reservedSlice = await sessionA.$transaction((tx) =>
      svcA.ledger.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retId,
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      }),
    );
    expect(reservedSlice).toBeTruthy();
    expect(money(reservedSlice!.commissionAmount)).toBe(5);
    expect(reservedSlice!.appliedAt).toBeNull();

    // Hold amount must match the ATTEMPT refund amount (partial return $50).
    let holdAmount = 0;
    let holdCents = 0;
    await sessionA.$transaction(async (tx) => {
      await svcA.holds.lockReturnRequest(tx, line.retId);
      const view = await svcA.holds.reserveInTransaction(tx, {
        returnRequestId: line.retId,
        orderShipmentId: line.shipId,
        supplierId,
        currency: 'usd',
        returnedMerchandise: 50,
        includeDelivery: false,
        siblingHadLiveLine: true,
      });
      holdAmount = Number(view.amount);
      holdCents = view.amountCents;
    });

    const attemptId = `${run}-att-f`;
    const submissionId = `${run}-sub-f`;
    const stripeRefundId = `re_f_${run}`;
    await sessionA.refundAttempt.create({
      data: {
        id: attemptId,
        operationKey: operationKeyForReturn(line.retId),
        kind: RefundAttemptKind.RETURN,
        status: RefundAttemptStatus.STRIPE_SUCCEEDED,
        orderId: line.orderId,
        returnRequestId: line.retId,
        orderItemId: line.itemId,
        orderShipmentId: line.shipId,
        supplierId,
        actorUserId: adminId,
        stripePaymentIntentId: `pi_f_${run}`,
        stripeRefundId,
        amount: holdAmount,
        amountCents: holdCents,
        currency: 'usd',
        includeDelivery: false,
      },
    });
    await sessionA.refundAttemptSubmission.create({
      data: {
        id: submissionId,
        refundAttemptId: attemptId,
        version: 1,
        stripeIdempotencyKey: `s244-f-${run}`,
        outcome: RefundSubmissionOutcome.SUCCEEDED,
        stripeRefundId,
        reconciliationResult: RefundReconciliationResult.MATCHED,
        submittedAt: new Date(),
      },
    });
    await sessionA.shipmentRefundHold.update({
      where: { returnRequestId: line.retId },
      data: { refundAttemptId: attemptId },
    });

    const before = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    expect(before.clawbackRows).toBe(1);
    expect(before.clawbackApplied).toBe(0);
    expect(before.holdStatus).toBe(ShipmentRefundHoldStatus.RESERVED);

    const clawbackSpy = jest.spyOn(svcA.commissions, 'clawbackForOrderItem');
    try {
      const applied = await svcA.attempts.applySuccessfulRefund({
        refundAttemptId: attemptId,
        actor: admin,
      });
      expect(applied.idempotent).toBe(false);
      expect(applied.attempt.status).toBe(RefundAttemptStatus.APPLIED);
      expect(clawbackSpy).not.toHaveBeenCalled();
    } finally {
      clawbackSpy.mockRestore();
    }

    const after = await snapshotFinancials({
      oicId: line.oicId,
      retId: line.retId,
      supplierId,
    });
    const claw = await sessionA.commissionClawback.findUniqueOrThrow({
      where: { returnRequestId: line.retId },
    });
    const attempt = await sessionA.refundAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    expect(claw.appliedAt).not.toBeNull();
    expect(money(claw.commissionAmount)).toBe(5);
    expect(after.clawbackRows).toBe(1);
    expect(after.clawbackApplied).toBe(1);
    expect(after.oicStatus).toBe(CommissionRecognitionStatus.SETTLEABLE);
    expect(after.allocationReversals).toBe(1);
    expect(after.creditAmount).toBe(5);
    expect(after.activeAllocation).toBe(5);
    expect(after.clawbackCredits).toBe(1);
    expect(after.holdStatus).toBe(ShipmentRefundHoldStatus.CONSUMED);
    expect(after.shipmentRefunded).toBe(50);
    expect(attempt.clawbackAppliedAt).not.toBeNull();
    expect(attempt.shipmentRefundApplied).toBe(true);
  });

  it('G) credit-application restoration on full-line clawback (partial and full)', async () => {
    await assertLiveConnectionIdentity(sessionA);

    const runCreditCase = async (label: string, creditAmount: number) => {
      const supplierId = await makeSupplier(label);
      const payable = await seedLegacyLine({
        label,
        supplierId,
        merchandise: 100,
        commission: 10,
        withHold: true,
        pendingFinalize: true,
      });

      // Anchor funding line (not settleable) + verified allocation + credit, then sweep
      // applies the credit onto the payable SETTLEABLE OIC.
      const anchorItemId = `${run}-item-${label}-anchor`;
      const anchorOicId = `${run}-oic-${label}-anchor`;
      await sessionA.orderItem.create({
        data: {
          id: anchorItemId,
          orderId: payable.orderId,
          productId: `${supplierId}-prod`,
          productName: 'S244 Anchor',
          supplierId,
          supplierName: supplierId,
          unitPrice: '10.00',
          quantity: 1,
          lineTotal: '10.00',
          status: 'PROCESSING',
        } as never,
      });
      await sessionA.orderItemCommission.create({
        data: {
          id: anchorOicId,
          orderItemId: anchorItemId,
          ratePercent: '10.00',
          commissionBase: creditAmount.toFixed(2),
          commissionAmount: creditAmount.toFixed(2),
          currency: 'USD',
          status: CommissionRecognitionStatus.RECOGNIZED,
          paymentMode: 'lipa',
          isDemo: false,
        },
      });
      const remittanceId = `${run}-rem-${label}`;
      const allocationId = `${run}-alloc-${label}`;
      const creditId = `${run}-credit-${label}`;
      await sessionA.commissionRemittance.create({
        data: {
          id: remittanceId,
          supplierId,
          method: CommissionRemittanceMethod.WINGER_LIPA,
          status: CommissionRemittanceStatus.VERIFIED,
          claimedAmount: creditAmount.toFixed(2),
          claimedCurrency: 'USD',
          verifiedAmountUsd: creditAmount.toFixed(2),
          verifiedAt: new Date('2026-03-01T00:00:00.000Z'),
          referenceRaw: remittanceId,
          referenceNormalized: remittanceId.toUpperCase(),
          provider: 'TEST',
          merchantAccountKey: `${run}-account`,
          autoApply: false,
          submittedByUserId: adminId,
        },
      });
      await sessionA.commissionAllocation.create({
        data: {
          id: allocationId,
          remittanceId,
          orderItemCommissionId: anchorOicId,
          amountUsd: creditAmount.toFixed(2),
          reason: CommissionAllocationReason.MANUAL,
          actorUserId: adminId,
          actorType: 'USER',
        },
      });
      await sessionA.commissionCredit.create({
        data: {
          id: creditId,
          supplierId,
          orderItemCommissionId: payable.oicId,
          amountUsd: creditAmount.toFixed(2),
          reason: CommissionCreditReason.CLAWBACK_AFTER_COLLECTION,
          sourceEventKey: `${run}-credit-key-${label}`,
          actorUserId: adminId,
          sources: {
            create: [
              {
                id: `${run}-csrc-${label}`,
                allocationId,
                amountUsd: creditAmount.toFixed(2),
              },
            ],
          },
        },
      });
      await svcA.ledger.sweepSupplier(supplierId);

      const before = await snapshotFinancials({
        oicId: payable.oicId,
        retId: payable.retId,
        supplierId,
      });
      expect(before.applicationSourceReversals).toBe(0);
      expect(before.oicStatus).toBe(CommissionRecognitionStatus.SETTLEABLE);
      const appliedBefore = await activeAppliedCredit(sessionA, creditId);
      expect(appliedBefore).toBe(creditAmount);

      const result = await svcA.holds.finalizeLegacySuccessfulRefund({
        returnRequestId: payable.retId,
        actor: admin,
      });
      expect(result.legacyClawback).toBe(true);

      const after = await snapshotFinancials({
        oicId: payable.oicId,
        retId: payable.retId,
        supplierId,
      });
      expect(after.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
      expect(after.applicationSourceReversals).toBeGreaterThan(0);
      expect(await activeAppliedCredit(sessionA, creditId)).toBe(0);
      expect(after.rrStatus).toBe(ReturnRefundStatus.ISSUED);
      expect(after.holdStatus).toBe(ShipmentRefundHoldStatus.CONSUMED);
      return after;
    };

    // Partial: $6 of credit applied against $10 commission line.
    const partialAfter = await runCreditCase('g-partial', 6);
    expect(partialAfter.applicationSourceReversals).toBeGreaterThanOrEqual(1);

    // Full: $10 of credit applied against $10 commission line.
    const fullAfter = await runCreditCase('g-full', 10);
    expect(fullAfter.applicationSourceReversals).toBeGreaterThanOrEqual(1);
  });
});

async function activeAppliedCredit(db: PrismaClient, creditId: string) {
  const rows = await db.commissionCreditApplication.findMany({
    where: { creditId },
    include: { sources: { include: { reversals: true } } },
  });
  return money(
    rows.reduce(
      (sum, row) =>
        sum +
        row.sources.reduce(
          (inner, source) =>
            inner +
            money(source.amountUsd) -
            source.reversals.reduce(
              (reversed, reversal) => reversed + money(reversal.amountUsd),
              0,
            ),
          0,
        ),
      0,
    ),
  );
}

async function cleanupRun(
  db: PrismaClient,
  input: {
    supplierIds: string[];
    userIds: string[];
    orderIds: string[];
    customerId: string;
  },
) {
  const suppliers = input.supplierIds.length
    ? input.supplierIds
    : [`${run}-none`];

  await db.shipmentRefundHoldLegacyEvidence.deleteMany({
    where: { shipmentRefundHold: { supplierId: { in: suppliers } } },
  });
  await db.shipmentRefundHold.deleteMany({
    where: { supplierId: { in: suppliers } },
  });
  await db.refundAttemptSubmission.deleteMany({
    where: { refundAttempt: { supplierId: { in: suppliers } } },
  });
  await db.refundAttempt.deleteMany({
    where: { supplierId: { in: suppliers } },
  });

  await db.commissionClawback.deleteMany({
    where: { returnRequest: { customerId: input.customerId } },
  });
  await db.commissionSystemEvent.deleteMany({
    where: { supplierId: { in: suppliers } },
  });
  await db.commissionCreditApplicationSourceReversal.deleteMany({
    where: {
      applicationSource: {
        creditSource: { credit: { supplierId: { in: suppliers } } },
      },
    },
  });
  await db.commissionCreditApplicationSource.deleteMany({
    where: {
      creditSource: { credit: { supplierId: { in: suppliers } } },
    },
  });
  await db.commissionCreditApplication.deleteMany({
    where: { credit: { supplierId: { in: suppliers } } },
  });
  await db.commissionCreditOffsetSource.deleteMany({
    where: {
      creditSource: { credit: { supplierId: { in: suppliers } } },
    },
  });
  await db.commissionCreditOffset.deleteMany({
    where: { credit: { supplierId: { in: suppliers } } },
  });
  await db.commissionCreditSource.deleteMany({
    where: { credit: { supplierId: { in: suppliers } } },
  });
  await db.commissionCredit.deleteMany({
    where: { supplierId: { in: suppliers } },
  });
  await db.commissionAllocationReversal.deleteMany({
    where: {
      allocation: { remittance: { supplierId: { in: suppliers } } },
    },
  });
  await db.commissionAllocation.deleteMany({
    where: { remittance: { supplierId: { in: suppliers } } },
  });
  await db.commissionProviderEvent.deleteMany({
    where: {
      remittanceReversal: { remittance: { supplierId: { in: suppliers } } },
    },
  });
  await db.commissionRemittanceReversal.deleteMany({
    where: { remittance: { supplierId: { in: suppliers } } },
  });
  await db.commissionPaymentReference.deleteMany({
    where: { remittance: { supplierId: { in: suppliers } } },
  });
  await db.commissionRemittance.deleteMany({
    where: { supplierId: { in: suppliers } },
  });
  await db.commissionRecognitionJob.deleteMany({
    where: { supplierId: { in: suppliers } },
  });

  if (input.userIds.length) {
    await db.auditLog.deleteMany({
      where: { actorUserId: { in: input.userIds } },
    });
  }

  await db.returnRequest.deleteMany({
    where: { customerId: input.customerId },
  });
  await db.orderItemCommission.deleteMany({
    where: { orderItem: { supplierId: { in: suppliers } } },
  });
  await db.orderShipment.deleteMany({
    where: { supplierId: { in: suppliers } },
  });
  await db.orderItem.deleteMany({
    where: { supplierId: { in: suppliers } },
  });
  if (input.orderIds.length) {
    await db.order.deleteMany({ where: { id: { in: input.orderIds } } });
  }
  await db.product.deleteMany({
    where: { supplierId: { in: suppliers } },
  });
  if (input.userIds.length) {
    await db.user.deleteMany({ where: { id: { in: input.userIds } } });
  }
  await db.supplier.deleteMany({ where: { id: { in: suppliers } } });
}
