/**
 * S2.4.25 / S2.4.28 — isolated PostgreSQL regression for concurrent reserveReturnClawback.
 *
 * Opt-in only:
 *   $env:S244_PG_TESTS = "1"
 *   $env:DATABASE_URL = "postgresql://winger:winger@127.0.0.1:5434/winger_s244?schema=public"
 *   npx jest --testPathPattern=reserve-return-clawback.postgres.integration --runInBand --no-coverage
 */
import {
  CommissionAllocationReason,
  CommissionRecognitionStatus,
  CommissionRemittanceMethod,
  CommissionRemittanceStatus,
  PrismaClient,
  ReturnRefundDrive,
  ReturnRefundStatus,
  ReturnRequestStatus,
  UserRole,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { ShipmentRefundHoldService } from '../orders/shipment-refund-hold.service';
import { AuditService } from './audit.service';
import { CommissionLedgerService } from './commission-ledger.service';
import { CommissionsService } from './commissions.service';

jest.setTimeout(120000);

const run = `s225${Date.now().toString(36)}`;
const optedIn = process.env.S244_PG_TESTS === '1';
const ISOLATED_HOST = '127.0.0.1';
const ISOLATED_PORT = '5434';
const ISOLATED_DB = 'winger_s244';
const ISOLATED_USER = 'winger';

function assertIsolatedDatabaseUrl(raw: string) {
  if (!raw) {
    throw new Error('DATABASE_URL is required for S2.4.25 isolated PG tests');
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

async function waitForUngranted(
  observer: PrismaClient,
  appNames: string[],
  minCount: number,
) {
  for (let i = 0; i < 120; i++) {
    const rows = await observer.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::bigint AS n
       FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE NOT l.granted
         AND a.application_name IN (${appNames.map((_, idx) => `$${idx + 1}`).join(', ')})`,
      ...appNames,
    );
    if (Number(rows[0].n) >= minCount) return;
    await sleep(50);
  }
  throw new Error(
    `Expected >= ${minCount} ungranted lock(s) for ${appNames.join(',')}`,
  );
}

describe('S225 PG opt-in gate', () => {
  it('does not connect without S244_PG_TESTS=1', () => {
    if (!optedIn) {
      expect(process.env.S244_PG_TESTS).not.toBe('1');
      return;
    }
    expect(process.env.S244_PG_TESTS).toBe('1');
  });
});

const suite = optedIn ? describe : describe.skip;

suite('S2.4.25 reserveReturnClawback concurrency (PostgreSQL)', () => {
  let rawUrl = '';
  let sessionA: PrismaClient;
  let sessionB: PrismaClient;
  let sessionGate: PrismaClient;
  let sessionObserver: PrismaClient;
  let ledgerA: CommissionLedgerService;
  let ledgerB: CommissionLedgerService;
  let commissionsA: CommissionsService;
  let commissionsB: CommissionsService;
  let holdsA: ShipmentRefundHoldService;
  let holdsB: ShipmentRefundHoldService;
  let admin: AuthUser;
  let customerId = '';
  let adminId = '';
  const supplierIds: string[] = [];
  const orderIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    rawUrl = process.env.DATABASE_URL ?? '';
    assertIsolatedDatabaseUrl(rawUrl);

    sessionA = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s225-a') } },
    });
    sessionB = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s225-b') } },
    });
    sessionGate = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s225-gate') } },
    });
    sessionObserver = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s225-obs') } },
    });
    await Promise.all([
      sessionA.$connect(),
      sessionB.$connect(),
      sessionGate.$connect(),
      sessionObserver.$connect(),
    ]);

    const identity = await sessionA.$queryRaw<
      { db: string; usr: string; ver: string }[]
    >`
      SELECT current_database() AS db,
             current_user AS usr,
             split_part(version(), ' ', 2) AS ver
    `;
    expect(identity[0].db).toBe(ISOLATED_DB);
    expect(identity[0].usr).toBe(ISOLATED_USER);
    expect(String(identity[0].ver).startsWith('18')).toBe(true);

    adminId = `${run}-admin`;
    customerId = `${run}-customer`;
    userIds.push(adminId, customerId);
    admin = {
      sub: adminId,
      email: `${run}-admin@s225.invalid`,
      name: 'S225 admin',
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
        email: `${run}-customer@s225.invalid`,
        passwordHash: 'fixture-not-a-login',
        name: 'S225 customer',
        role: UserRole.CUSTOMER,
      },
    });

    const auditA = new AuditService(sessionA as never);
    const auditB = new AuditService(sessionB as never);
    ledgerA = new CommissionLedgerService(sessionA as never, auditA, {} as never);
    ledgerB = new CommissionLedgerService(sessionB as never, auditB, {} as never);
    commissionsA = new CommissionsService(sessionA as never, auditA, ledgerA);
    commissionsB = new CommissionsService(sessionB as never, auditB, ledgerB);
    holdsA = new ShipmentRefundHoldService(
      sessionA as never,
      ledgerA,
      commissionsA,
    );
    holdsB = new ShipmentRefundHoldService(
      sessionB as never,
      ledgerB,
      commissionsB,
    );
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
        name: `S225 FIXTURE ${label}`,
        verificationStatus: 'APPROVED',
      },
    });
    supplierIds.push(supplierId);
    await sessionA.product.create({
      data: {
        id: `${supplierId}-prod`,
        name: `S225 ${label}`,
        brand: 'S225',
        supplierId,
        supplierName: `S225 FIXTURE ${label}`,
        price: '100.00',
        imageUrl: 'https://example.invalid/s225.png',
        category: 's225-fixture',
      },
    });
    return supplierId;
  }

  async function seedLine(input: {
    label: string;
    supplierId: string;
    merchandise: number;
    commission: number;
    quantity: number;
    returnCount?: number;
  }) {
    const qty = input.quantity;
    const orderId = `${run}-ord-${input.label}`;
    const itemId = `${run}-item-${input.label}`;
    const oicId = `${run}-oic-${input.label}`;
    orderIds.push(orderId);
    const returnCount = input.returnCount ?? 1;
    const retIds: string[] = [];

    await sessionA.order.create({
      data: {
        id: orderId,
        displayId: `S225-${input.label}`,
        customerId,
        customerName: 'S225',
        customerEmail: `${run}-customer@s225.invalid`,
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
        productName: 'S225 Widget',
        supplierId: input.supplierId,
        supplierName: input.supplierId,
        unitPrice: money(input.merchandise / qty),
        quantity: qty,
        lineTotal: input.merchandise,
        status: 'DELIVERED',
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
        paymentMode: 'lipa',
        isDemo: false,
        settleableAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    for (let i = 0; i < returnCount; i++) {
      const retId = `${run}-ret-${input.label}-${i + 1}`;
      retIds.push(retId);
      await sessionA.returnRequest.create({
        data: {
          id: retId,
          orderId,
          orderItemId: itemId,
          customerId,
          reason: `s225-${input.label}-${i + 1}`,
          quantity: 1,
          status: ReturnRequestStatus.APPROVED,
          refundStatus: ReturnRefundStatus.PENDING,
          refundDrive: ReturnRefundDrive.ATTEMPT,
        } as never,
      });
    }
    return { orderId, itemId, oicId, retIds };
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
    await ledgerA.sweepSupplier(input.supplierId);
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

  it('R1) concurrent reserves without OrderItem lock serialise on OIC and stay within commission', async () => {
    const supplierId = await makeSupplier('r1');
    // Prior reserved $5; two later qty-1 reserves must not both take $3.33 from stale priors.
    const line = await seedLine({
      label: 'r1',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 3,
      returnCount: 3,
    });
    await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retIds[0],
        quantity: 1,
        unitPrice: money(100 / 3),
        lineQuantity: 3,
      }),
    );

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
      { timeout: 60000 },
    );
    while (!gateLocked) await sleep(20);

    const raceA = sessionA.$transaction(
      (tx) =>
        ledgerA.reserveReturnClawback(tx, {
          orderItemId: line.itemId,
          returnRequestId: line.retIds[1],
          quantity: 1,
          unitPrice: money(100 / 3),
          lineQuantity: 3,
        }),
      { timeout: 60000 },
    );
    const raceB = sessionB.$transaction(
      (tx) =>
        ledgerB.reserveReturnClawback(tx, {
          orderItemId: line.itemId,
          returnRequestId: line.retIds[2],
          quantity: 1,
          unitPrice: money(100 / 3),
          lineQuantity: 3,
        }),
      { timeout: 60000 },
    );
    await waitForUngranted(sessionObserver, ['winger-s225-a', 'winger-s225-b'], 2);
    releaseGate();
    await gateHold;
    const settled = await Promise.allSettled([raceA, raceB]);
    expect(settled.every((row) => row.status === 'fulfilled')).toBe(true);

    const rows = await sessionA.commissionClawback.findMany({
      where: { orderItemCommissionId: line.oicId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(3);
    const total = money(
      rows.reduce((sum, row) => sum + money(row.commissionAmount), 0),
    );
    expect(total).toBe(10);
    expect(rows.map((row) => money(row.commissionAmount)).sort((a, b) => a - b)).toEqual([
      3.33, 3.33, 3.34,
    ]);
  });

  it('R2) same-return retry is idempotent', async () => {
    const supplierId = await makeSupplier('r2');
    const line = await seedLine({
      label: 'r2',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 2,
      returnCount: 1,
    });
    const first = await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retIds[0],
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      }),
    );
    const second = await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retIds[0],
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      }),
    );
    expect(first!.id).toBe(second!.id);
    expect(money(first!.commissionAmount)).toBe(5);
    expect(
      await sessionA.commissionClawback.count({
        where: { orderItemCommissionId: line.oicId },
      }),
    ).toBe(1);
  });

  it('R3) reserve after full-line CLAWED_BACK is refused', async () => {
    const supplierId = await makeSupplier('r3');
    const line = await seedLine({
      label: 'r3',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 1,
      returnCount: 1,
    });
    await sessionA.$transaction((tx) =>
      commissionsA.clawbackForOrderItem({
        orderItemId: line.itemId,
        actor: admin,
        tx,
      }),
    );
    const oic = await sessionA.orderItemCommission.findUniqueOrThrow({
      where: { id: line.oicId },
    });
    expect(oic.status).toBe(CommissionRecognitionStatus.CLAWED_BACK);

    await expect(
      sessionA.$transaction((tx) =>
        ledgerA.reserveReturnClawback(tx, {
          orderItemId: line.itemId,
          returnRequestId: line.retIds[0],
          quantity: 1,
          unitPrice: 100,
          lineQuantity: 1,
        }),
      ),
    ).rejects.toThrow(/clawed back/i);
    expect(
      await sessionA.commissionClawback.count({
        where: { orderItemCommissionId: line.oicId },
      }),
    ).toBe(0);
  });

  it('R4) rollback after reserve write leaves no row; retry succeeds once', async () => {
    const supplierId = await makeSupplier('r4');
    const line = await seedLine({
      label: 'r4',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 2,
      returnCount: 1,
    });

    await expect(
      sessionA.$transaction(async (tx) => {
        const reserved = await ledgerA.reserveReturnClawback(tx, {
          orderItemId: line.itemId,
          returnRequestId: line.retIds[0],
          quantity: 1,
          unitPrice: 50,
          lineQuantity: 2,
        });
        expect(money(reserved!.commissionAmount)).toBe(5);
        throw new Error('s225-controlled-rollback');
      }),
    ).rejects.toThrow('s225-controlled-rollback');

    expect(
      await sessionA.commissionClawback.count({
        where: { orderItemCommissionId: line.oicId },
      }),
    ).toBe(0);

    const retry = await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retIds[0],
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      }),
    );
    expect(money(retry!.commissionAmount)).toBe(5);
    expect(
      await sessionA.commissionClawback.count({
        where: { orderItemCommissionId: line.oicId },
      }),
    ).toBe(1);
  });

  it('R5) reserve waiting on OIC does not take supplier locks', async () => {
    const supplierId = await makeSupplier('r5');
    const line = await seedLine({
      label: 'r5',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 2,
      returnCount: 1,
    });

    let gateLocked = false;
    let releaseGate = () => {};
    const gateOpen = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const advisoryKey = `commission-ledger:${supplierId}`;
    const gateHold = sessionGate.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${advisoryKey}, 0))
        `;
        gateLocked = true;
        await gateOpen;
      },
      { timeout: 60000 },
    );
    while (!gateLocked) await sleep(20);

    // Must complete while supplier advisory is held — proves reserve takes no supplier lock.
    const reserved = await withTimeout(
      sessionA.$transaction((tx) =>
        ledgerA.reserveReturnClawback(tx, {
          orderItemId: line.itemId,
          returnRequestId: line.retIds[0],
          quantity: 1,
          unitPrice: 50,
          lineQuantity: 2,
        }),
      ),
      10000,
      'reserve blocked on supplier advisory unexpectedly',
    );
    expect(money(reserved!.commissionAmount)).toBe(5);
    releaseGate();
    await gateHold;
  });

  it('G1) concurrent same-return reservation is idempotent under OIC contention', async () => {
    const supplierId = await makeSupplier('g1');
    const line = await seedLine({
      label: 'g1',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 2,
      returnCount: 1,
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
      { timeout: 60000 },
    );
    while (!gateLocked) await sleep(20);

    const raceA = sessionA.$transaction(
      (tx) =>
        ledgerA.reserveReturnClawback(tx, {
          orderItemId: line.itemId,
          returnRequestId: line.retIds[0],
          quantity: 1,
          unitPrice: 50,
          lineQuantity: 2,
        }),
      { timeout: 60000 },
    );
    const raceB = sessionB.$transaction(
      (tx) =>
        ledgerB.reserveReturnClawback(tx, {
          orderItemId: line.itemId,
          returnRequestId: line.retIds[0],
          quantity: 1,
          unitPrice: 50,
          lineQuantity: 2,
        }),
      { timeout: 60000 },
    );
    await waitForUngranted(sessionObserver, ['winger-s225-a', 'winger-s225-b'], 2);
    releaseGate();
    await gateHold;
    const settled = await Promise.allSettled([raceA, raceB]);
    expect(settled.every((row) => row.status === 'fulfilled')).toBe(true);
    const values = settled.map(
      (row) => (row as PromiseFulfilledResult<{ id: string; commissionAmount: unknown }>).value,
    );
    expect(values[0].id).toBe(values[1].id);
    expect(money(values[0].commissionAmount)).toBe(5);
    expect(money(values[1].commissionAmount)).toBe(5);
    expect(
      await sessionA.commissionClawback.count({
        where: { orderItemCommissionId: line.oicId },
      }),
    ).toBe(1);
  });

  it('G2a) apply holds OIC first; concurrent reserve waits then sees applied history', async () => {
    const supplierId = await makeSupplier('g2a');
    const line = await seedLine({
      label: 'g2a',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 2,
      returnCount: 2,
    });
    await seedVerifiedAllocation({
      label: 'g2a',
      supplierId,
      oicId: line.oicId,
      amount: 10,
    });
    await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retIds[0],
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      }),
    );

    let applyHolding = false;
    let releaseApply = () => {};
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const applyP = sessionA.$transaction(
      async (tx) => {
        const result = await ledgerA.applyReturnClawback(tx, {
          returnRequestId: line.retIds[0],
          actor: admin,
        });
        applyHolding = true;
        await applyGate;
        return result;
      },
      { timeout: 60000 },
    );
    while (!applyHolding) await sleep(20);

    const reserveP = sessionB.$transaction(
      (tx) =>
        ledgerB.reserveReturnClawback(tx, {
          orderItemId: line.itemId,
          returnRequestId: line.retIds[1],
          quantity: 1,
          unitPrice: 50,
          lineQuantity: 2,
        }),
      { timeout: 60000 },
    );
    await waitForUngranted(sessionObserver, ['winger-s225-b'], 1);

    releaseApply();
    const applied = await withTimeout(applyP, 30000, 'apply timed out');
    expect(applied).toEqual({ legacy: false, applied: true });
    const reserved = await withTimeout(reserveP, 30000, 'reserve timed out');
    expect(money(reserved!.commissionAmount)).toBe(5);

    const claw = await sessionA.commissionClawback.findUniqueOrThrow({
      where: { returnRequestId: line.retIds[0] },
    });
    expect(claw.appliedAt).not.toBeNull();
    expect(money(claw.commissionAmount)).toBe(5);
    const second = await sessionA.commissionClawback.findUniqueOrThrow({
      where: { returnRequestId: line.retIds[1] },
    });
    expect(second.appliedAt).toBeNull();
    expect(money(second.commissionAmount)).toBe(5);
    expect(
      await sessionA.commissionClawback.count({
        where: { orderItemCommissionId: line.oicId },
      }),
    ).toBe(2);
    const oic = await sessionA.orderItemCommission.findUniqueOrThrow({
      where: { id: line.oicId },
    });
    expect(oic.status).toBe(CommissionRecognitionStatus.SETTLEABLE);
  });

  it('G2b) reserve holds OIC first; concurrent apply waits then uses persisted slice', async () => {
    const supplierId = await makeSupplier('g2b');
    const line = await seedLine({
      label: 'g2b',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 2,
      returnCount: 2,
    });
    await seedVerifiedAllocation({
      label: 'g2b',
      supplierId,
      oicId: line.oicId,
      amount: 10,
    });
    await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retIds[0],
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      }),
    );

    let reserveHolding = false;
    let releaseReserve = () => {};
    const reserveGate = new Promise<void>((resolve) => {
      releaseReserve = resolve;
    });
    const reserveP = sessionA.$transaction(
      async (tx) => {
        const result = await ledgerA.reserveReturnClawback(tx, {
          orderItemId: line.itemId,
          returnRequestId: line.retIds[1],
          quantity: 1,
          unitPrice: 50,
          lineQuantity: 2,
        });
        reserveHolding = true;
        await reserveGate;
        return result;
      },
      { timeout: 60000 },
    );
    while (!reserveHolding) await sleep(20);

    const applyP = sessionB.$transaction(
      (tx) =>
        ledgerB.applyReturnClawback(tx, {
          returnRequestId: line.retIds[0],
          actor: admin,
        }),
      { timeout: 60000 },
    );
    await waitForUngranted(sessionObserver, ['winger-s225-b'], 1);

    releaseReserve();
    const reserved = await withTimeout(reserveP, 30000, 'reserve timed out');
    expect(money(reserved!.commissionAmount)).toBe(5);
    const applied = await withTimeout(applyP, 30000, 'apply timed out');
    expect(applied).toEqual({ legacy: false, applied: true });

    const first = await sessionA.commissionClawback.findUniqueOrThrow({
      where: { returnRequestId: line.retIds[0] },
    });
    expect(first.appliedAt).not.toBeNull();
    expect(money(first.commissionAmount)).toBe(5);
    const second = await sessionA.commissionClawback.findUniqueOrThrow({
      where: { returnRequestId: line.retIds[1] },
    });
    expect(second.appliedAt).toBeNull();
    expect(money(second.commissionAmount)).toBe(5);
    const reversals = await sessionA.commissionAllocationReversal.count({
      where: {
        allocation: { remittance: { supplierId } },
      },
    });
    expect(reversals).toBe(1);
    const credits = await sessionA.commissionCredit.count({
      where: { supplierId },
    });
    expect(credits).toBe(1);
  });

  it('G3a-seq) committed reservation makes LEGACY complete use proportional path', async () => {
    const supplierId = await makeSupplier('g3aseq');
    const line = await seedLine({
      label: 'g3aseq',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 1,
      returnCount: 1,
    });
    await seedVerifiedAllocation({
      label: 'g3aseq',
      supplierId,
      oicId: line.oicId,
      amount: 10,
    });
    await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retIds[0],
        quantity: 1,
        unitPrice: 100,
        lineQuantity: 1,
      }),
    );

    const legacy = await sessionA.$transaction((tx) =>
      holdsA.completeLegacyReturnCommissionInTx(tx, {
        returnRequestId: line.retIds[0],
        orderItemId: line.itemId,
        actor: admin,
      }),
    );
    expect(legacy.fullLineApplied).toBe(false);
    const claw = await sessionA.commissionClawback.findUniqueOrThrow({
      where: { returnRequestId: line.retIds[0] },
    });
    expect(claw.appliedAt).not.toBeNull();
    expect(money(claw.commissionAmount)).toBe(10);
    expect(
      await sessionA.commissionClawback.count({
        where: { orderItemCommissionId: line.oicId },
      }),
    ).toBe(1);
  });

  /**
   * S2.4.30 regression: reservation-versus-LEGACY finalisation race.
   * Reserve holds OIC with an uncommitted CommissionClawback; concurrent
   * completeLegacyReturnCommissionInTx must block on that OIC lock. After the
   * reservation commits, LEGACY finalisation must apply the proportional
   * reservation (fullLineApplied === false), not fall through to full-line
   * clawbackForOrderItem. applyReturnClawback acquires OIC before returning
   * legacy so the proportional-versus-full-line decision stays serialised.
   */
  it('G3a-race) reserve holds OIC uncommitted; LEGACY complete must not full-line after reservation commits', async () => {
    const supplierId = await makeSupplier('g3a');
    const line = await seedLine({
      label: 'g3a',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 1,
      returnCount: 1,
    });
    await seedVerifiedAllocation({
      label: 'g3a',
      supplierId,
      oicId: line.oicId,
      amount: 10,
    });

    let reserveHolding = false;
    let releaseReserve = () => {};
    const reserveGate = new Promise<void>((resolve) => {
      releaseReserve = resolve;
    });
    const reserveP = sessionA.$transaction(
      async (tx) => {
        const result = await ledgerA.reserveReturnClawback(tx, {
          orderItemId: line.itemId,
          returnRequestId: line.retIds[0],
          quantity: 1,
          unitPrice: 100,
          lineQuantity: 1,
        });
        reserveHolding = true;
        await reserveGate;
        return result;
      },
      { timeout: 60000 },
    );
    while (!reserveHolding) await sleep(20);

    const legacyP = sessionB.$transaction(
      (tx) =>
        holdsB.completeLegacyReturnCommissionInTx(tx, {
          returnRequestId: line.retIds[0],
          orderItemId: line.itemId,
          actor: admin,
        }),
      { timeout: 60000 },
    );
    await waitForUngranted(sessionObserver, ['winger-s225-b'], 1);

    releaseReserve();
    const reserved = await withTimeout(reserveP, 30000, 'reserve timed out');
    expect(money(reserved!.commissionAmount)).toBe(10);
    const legacy = await withTimeout(legacyP, 30000, 'legacy complete timed out');

    // Required property: reservation visible after OIC wait ⇒ proportional, not full-line.
    expect(legacy.fullLineApplied).toBe(false);
    const claw = await sessionA.commissionClawback.findUniqueOrThrow({
      where: { returnRequestId: line.retIds[0] },
    });
    expect(claw.appliedAt).not.toBeNull();
    expect(money(claw.commissionAmount)).toBe(10);
    expect(
      await sessionA.commissionClawback.count({
        where: { orderItemCommissionId: line.oicId },
      }),
    ).toBe(1);
    const oic = await sessionA.orderItemCommission.findUniqueOrThrow({
      where: { id: line.oicId },
    });
    expect(oic.status).toBe(CommissionRecognitionStatus.CLAWED_BACK);
  });

  it('G3b) full-line CLAWED_BACK commits first; concurrent new reserve is rejected', async () => {
    const supplierId = await makeSupplier('g3b');
    const line = await seedLine({
      label: 'g3b',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 1,
      returnCount: 1,
    });

    let clawHolding = false;
    let releaseClaw = () => {};
    const clawGate = new Promise<void>((resolve) => {
      releaseClaw = resolve;
    });
    const clawP = sessionA.$transaction(
      async (tx) => {
        const result = await commissionsA.clawbackForOrderItem({
          orderItemId: line.itemId,
          actor: admin,
          tx,
        });
        clawHolding = true;
        await clawGate;
        return result;
      },
      { timeout: 60000 },
    );
    while (!clawHolding) await sleep(20);

    const reserveP = sessionB.$transaction(
      (tx) =>
        ledgerB.reserveReturnClawback(tx, {
          orderItemId: line.itemId,
          returnRequestId: line.retIds[0],
          quantity: 1,
          unitPrice: 100,
          lineQuantity: 1,
        }),
      { timeout: 60000 },
    );
    await waitForUngranted(sessionObserver, ['winger-s225-b'], 1);

    releaseClaw();
    const clawed = await withTimeout(clawP, 30000, 'full-line clawback timed out');
    expect(clawed.clawedBack).toBe(true);
    await expect(
      withTimeout(reserveP, 30000, 'reserve timed out'),
    ).rejects.toThrow(/clawed back/i);

    expect(
      await sessionA.commissionClawback.count({
        where: { orderItemCommissionId: line.oicId },
      }),
    ).toBe(0);
    const oic = await sessionA.orderItemCommission.findUniqueOrThrow({
      where: { id: line.oicId },
    });
    expect(oic.status).toBe(CommissionRecognitionStatus.CLAWED_BACK);
  });

  it('G4) existing reservation retry succeeds after OIC becomes CLAWED_BACK', async () => {
    const supplierId = await makeSupplier('g4');
    const line = await seedLine({
      label: 'g4',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 2,
      returnCount: 1,
    });
    const first = await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retIds[0],
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      }),
    );
    expect(money(first!.commissionAmount)).toBe(5);

    await sessionA.$transaction((tx) =>
      commissionsA.clawbackForOrderItem({
        orderItemId: line.itemId,
        actor: admin,
        returnRequestId: line.retIds[0],
        tx,
      }),
    );
    const oic = await sessionA.orderItemCommission.findUniqueOrThrow({
      where: { id: line.oicId },
    });
    expect(oic.status).toBe(CommissionRecognitionStatus.CLAWED_BACK);

    const retry = await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retIds[0],
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      }),
    );
    expect(retry!.id).toBe(first!.id);
    expect(money(retry!.commissionAmount)).toBe(5);
    expect(
      await sessionA.commissionClawback.count({
        where: { orderItemCommissionId: line.oicId },
      }),
    ).toBe(1);
  });
});

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
  await db.commissionRemittance.deleteMany({
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
