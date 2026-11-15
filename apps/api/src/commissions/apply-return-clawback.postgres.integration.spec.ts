/**
 * S2.4.21 — isolated PostgreSQL regression for proportional clawback concurrency.
 *
 * Opt-in only (no DB connect without the flag):
 *   $env:S244_PG_TESTS = "1"
 *   $env:DATABASE_URL = "postgresql://winger:winger@127.0.0.1:5434/winger_s244?schema=public"
 *   npx jest --testPathPattern=apply-return-clawback.postgres.integration --runInBand --no-coverage
 *
 * Does NOT call Stripe. Does NOT modify .env. Does NOT target 5433/winger.
 */
import {
  CommissionAllocationReason,
  CommissionCreditReason,
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
import { AuditService } from './audit.service';
import { CommissionLedgerService } from './commission-ledger.service';

jest.setTimeout(120000);

const run = `s221${Date.now().toString(36)}`;
const optedIn = process.env.S244_PG_TESTS === '1';
const ISOLATED_HOST = '127.0.0.1';
const ISOLATED_PORT = '5434';
const ISOLATED_DB = 'winger_s244';
const ISOLATED_USER = 'winger';

function assertIsolatedDatabaseUrl(raw: string) {
  if (!raw) {
    throw new Error('DATABASE_URL is required for S2.4.21 isolated PG tests');
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

describe('S221 PG opt-in gate', () => {
  it('does not connect without S244_PG_TESTS=1', () => {
    if (!optedIn) {
      expect(process.env.S244_PG_TESTS).not.toBe('1');
      return;
    }
    expect(process.env.S244_PG_TESTS).toBe('1');
  });
});

const suite = optedIn ? describe : describe.skip;

suite('S2.4.21 proportional clawback concurrency (PostgreSQL)', () => {
  let rawUrl = '';
  let sessionA: PrismaClient;
  let sessionB: PrismaClient;
  let sessionGate: PrismaClient;
  let sessionObserver: PrismaClient;
  let ledgerA: CommissionLedgerService;
  let ledgerB: CommissionLedgerService;
  let admin: AuthUser;
  let customerId = '';
  let adminId = '';
  const supplierIds: string[] = [];
  const orderIds: string[] = [];
  const userIds: string[] = [];

  async function assertLiveConnectionIdentity(db: PrismaClient) {
    const rows = await db.$queryRaw<
      { db: string; usr: string; ver: string; port: number }[]
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
    expect(Number(row.port)).toBe(5432);
    assertIsolatedDatabaseUrl(rawUrl);
  }

  beforeAll(async () => {
    rawUrl = process.env.DATABASE_URL ?? '';
    assertIsolatedDatabaseUrl(rawUrl);

    sessionA = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s221-a') } },
    });
    sessionB = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s221-b') } },
    });
    sessionGate = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s221-gate') } },
    });
    sessionObserver = new PrismaClient({
      datasources: { db: { url: sessionUrl(rawUrl, 'winger-s221-obs') } },
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
      email: `${run}-admin@s221.invalid`,
      name: 'S221 admin',
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
        email: `${run}-customer@s221.invalid`,
        passwordHash: 'fixture-not-a-login',
        name: 'S221 customer',
        role: UserRole.CUSTOMER,
      },
    });

    const auditA = new AuditService(sessionA as never);
    const auditB = new AuditService(sessionB as never);
    ledgerA = new CommissionLedgerService(sessionA as never, auditA, {} as never);
    ledgerB = new CommissionLedgerService(sessionB as never, auditB, {} as never);
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
        name: `S221 FIXTURE ${label}`,
        verificationStatus: 'APPROVED',
      },
    });
    supplierIds.push(supplierId);
    await sessionA.product.create({
      data: {
        id: `${supplierId}-prod`,
        name: `S221 ${label}`,
        brand: 'S221',
        supplierId,
        supplierName: `S221 FIXTURE ${label}`,
        price: '100.00',
        imageUrl: 'https://example.invalid/s221.png',
        category: 's221-fixture',
      },
    });
    return supplierId;
  }

  async function seedLine(input: {
    label: string;
    supplierId: string;
    merchandise: number;
    commission: number;
    quantity?: number;
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
        displayId: `S221-${input.label}`,
        customerId,
        customerName: 'S221',
        customerEmail: `${run}-customer@s221.invalid`,
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
        productName: 'S221 Widget',
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
        reason: 's221-fixture',
        quantity: qty,
        status: ReturnRequestStatus.APPROVED,
        refundStatus: ReturnRefundStatus.PENDING,
        refundDrive: ReturnRefundDrive.ATTEMPT,
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
    return { orderId, itemId, shipId, retId, oicId };
  }

  async function seedVerifiedRemittance(input: {
    label: string;
    supplierId: string;
    amount: number;
    autoApply?: boolean;
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
        autoApply: input.autoApply ?? true,
        submittedByUserId: adminId,
      },
    });
    return remittanceId;
  }

  async function seedVerifiedAllocation(input: {
    label: string;
    supplierId: string;
    oicId: string;
    amount: number;
  }) {
    const remittanceId = await seedVerifiedRemittance({
      label: input.label,
      supplierId: input.supplierId,
      amount: input.amount,
      autoApply: true,
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

  async function holdSupplierAdvisory(supplierId: string) {
    let locked = false;
    let release = () => {};
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const advisoryKey = `commission-ledger:${supplierId}`;
    const hold = sessionGate.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${advisoryKey}, 0))
        `;
        locked = true;
        await open;
      },
      { timeout: 60000 },
    );
    while (!locked) await sleep(20);
    return { hold, release };
  }

  async function financials(input: {
    oicId: string;
    supplierId: string;
    retIds?: string[];
  }) {
    const oic = await sessionA.orderItemCommission.findUnique({
      where: { id: input.oicId },
    });
    const clawbacks = await sessionA.commissionClawback.findMany({
      where: { orderItemCommissionId: input.oicId },
    });
    const allocationReversals = await sessionA.commissionAllocationReversal.findMany({
      where: {
        allocation: { remittance: { supplierId: input.supplierId } },
      },
    });
    const credits = await sessionA.commissionCredit.findMany({
      where: {
        supplierId: input.supplierId,
        reason: CommissionCreditReason.CLAWBACK_AFTER_COLLECTION,
      },
      include: { sources: true },
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
          row.reversals.reduce((inner, rev) => inner + money(rev.amountUsd), 0),
        0,
      ),
    );
    const creditBalance = money(
      credits.reduce((sum, row) => sum + money(row.amountUsd), 0),
    );
    return {
      oicStatus: oic?.status ?? null,
      clawbackRows: clawbacks.length,
      clawbackApplied: clawbacks.filter((row) => row.appliedAt != null).length,
      appliedAmounts: clawbacks
        .filter((row) => row.appliedAt != null)
        .map((row) => money(row.commissionAmount))
        .sort((a, b) => a - b),
      allocationReversals: allocationReversals.length,
      reversalAmount: money(
        allocationReversals.reduce((sum, row) => sum + money(row.amountUsd), 0),
      ),
      clawbackCredits: credits.length,
      creditBalance,
      activeAllocation,
      retApplied: input.retIds
        ? (
            await Promise.all(
              input.retIds.map((id) =>
                sessionA.commissionClawback.findUnique({
                  where: { returnRequestId: id },
                }),
              ),
            )
          ).map((row) => (row?.appliedAt ? money(row.commissionAmount) : null))
        : [],
    };
  }

  it('A) sweep-committed allocation is included in post-lock proportional snapshot', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('a');
    const line = await seedLine({
      label: 'a',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 1,
    });
    // Remittance ready; allocation created only while clawback waits on supplier mutex.
    const remittanceId = await seedVerifiedRemittance({
      label: 'a',
      supplierId,
      amount: 10,
      autoApply: false,
    });
    await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retId,
        quantity: 1,
        unitPrice: 100,
        lineQuantity: 1,
      }),
    );

    const gate = await holdSupplierAdvisory(supplierId);
    const applyP = sessionA.$transaction(
      (tx) =>
        ledgerA.applyReturnClawback(tx, {
          returnRequestId: line.retId,
          actor: admin,
        }),
      { timeout: 60000 },
    );
    await waitForUngranted(sessionObserver, ['winger-s221-a'], 1);

    // Committed before clawback's post-lock snapshot (gate owns supplier mutex;
    // insert uses an independent client so KEY SHARE on OIC coexists with NKU).
    await sessionObserver.commissionAllocation.create({
      data: {
        id: `${run}-alloc-a-late`,
        remittanceId,
        orderItemCommissionId: line.oicId,
        amountUsd: '10.00',
        reason: CommissionAllocationReason.MANUAL,
        actorUserId: adminId,
        actorType: 'USER',
      },
    });
    const late = await sessionB.commissionAllocation.findUniqueOrThrow({
      where: { id: `${run}-alloc-a-late` },
    });
    expect(money(late.amountUsd)).toBe(10);

    gate.release();
    await gate.hold;
    const result = await withTimeout(applyP, 30000, 'applyReturnClawback timed out');
    expect(result).toEqual({ legacy: false, applied: true });

    const after = await financials({
      oicId: line.oicId,
      supplierId,
      retIds: [line.retId],
    });
    expect(after.clawbackApplied).toBe(1);
    expect(after.allocationReversals).toBe(1);
    expect(after.reversalAmount).toBe(10);
    expect(after.creditBalance).toBe(10);
    expect(after.activeAllocation).toBe(0);
    expect(after.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
    expect(after.retApplied).toEqual([10]);
  });

  it('B) sweep cannot pass supplier mutex while clawback owns it', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('b');
    const line = await seedLine({
      label: 'b',
      supplierId,
      merchandise: 100,
      commission: 10,
    });
    await seedVerifiedAllocation({
      label: 'b',
      supplierId,
      oicId: line.oicId,
      amount: 10,
    });
    await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retId,
        quantity: 1,
        unitPrice: 100,
        lineQuantity: 1,
      }),
    );

    // Second remittance for sweep to allocate after clawback releases.
    const rem2 = await seedVerifiedRemittance({
      label: 'b2',
      supplierId,
      amount: 5,
      autoApply: true,
    });
    const secondLine = await seedLine({
      label: 'b2',
      supplierId,
      merchandise: 50,
      commission: 5,
    });

    let applyHolding = false;
    let releaseApply = () => {};
    const applyGate = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const applyP = sessionA.$transaction(
      async (tx) => {
        const result = await ledgerA.applyReturnClawback(tx, {
          returnRequestId: line.retId,
          actor: admin,
        });
        applyHolding = true;
        await applyGate;
        return result;
      },
      { timeout: 60000 },
    );
    while (!applyHolding) await sleep(20);

    const sweepP = ledgerB.sweepSupplier(supplierId);
    await waitForUngranted(sessionObserver, ['winger-s221-b'], 1);

    const midAlloc = await sessionObserver.commissionAllocation.count({
      where: { remittanceId: rem2 },
    });
    expect(midAlloc).toBe(0);

    releaseApply();
    const applied = await withTimeout(applyP, 30000, 'apply timed out');
    expect(applied).toEqual({ legacy: false, applied: true });
    await withTimeout(sweepP, 30000, 'sweep timed out');

    const after = await financials({
      oicId: line.oicId,
      supplierId,
      retIds: [line.retId],
    });
    expect(after.clawbackApplied).toBe(1);
    expect(after.reversalAmount).toBe(10);
    expect(after.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
    expect(after.activeAllocation).toBeGreaterThanOrEqual(0);
    expect(after.creditBalance).toBeGreaterThanOrEqual(0);

    // Sweep progressed after the mutex released (cash alloc and/or credit apply).
    const rem2Allocs = await sessionA.commissionAllocation.count({
      where: { remittanceId: rem2 },
    });
    const secondApps = await sessionA.commissionCreditApplication.count({
      where: { orderItemCommissionId: secondLine.oicId },
    });
    expect(rem2Allocs + secondApps).toBeGreaterThan(0);
  });

  it('C) zero-credit supplier advisory still serialises', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('c');
    const credits = await sessionA.commissionCredit.count({ where: { supplierId } });
    expect(credits).toBe(0);

    const gate = await holdSupplierAdvisory(supplierId);
    const sweepP = ledgerA.sweepSupplier(supplierId);
    await waitForUngranted(sessionObserver, ['winger-s221-a'], 1);
    gate.release();
    await gate.hold;
    await withTimeout(sweepP, 30000, 'zero-credit sweep timed out');

    // Second client also acquires the same empty-supplier mutex without error.
    await withTimeout(ledgerB.sweepSupplier(supplierId), 30000, 'second sweep timed out');
  });

  it('D) concurrent proportional returns on the same OIC serialise correctly', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('d');
    const line = await seedLine({
      label: 'd',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 2,
    });
    await seedVerifiedAllocation({
      label: 'd',
      supplierId,
      oicId: line.oicId,
      amount: 10,
    });

    const ret2 = `${run}-ret-d2`;
    await sessionA.returnRequest.create({
      data: {
        id: ret2,
        orderId: line.orderId,
        orderItemId: line.itemId,
        customerId,
        reason: 's221-d2',
        quantity: 1,
        status: ReturnRequestStatus.APPROVED,
        refundStatus: ReturnRefundStatus.PENDING,
        refundDrive: ReturnRefundDrive.ATTEMPT,
      } as never,
    });

    await sessionA.$transaction(async (tx) => {
      await ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retId,
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      });
      await ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: ret2,
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      });
    });

    const gate = await holdSupplierAdvisory(supplierId);
    const raceA = sessionA.$transaction(
      (tx) =>
        ledgerA.applyReturnClawback(tx, {
          returnRequestId: line.retId,
          actor: admin,
        }),
      { timeout: 60000 },
    );
    const raceB = sessionB.$transaction(
      (tx) =>
        ledgerB.applyReturnClawback(tx, {
          returnRequestId: ret2,
          actor: admin,
        }),
      { timeout: 60000 },
    );
    await waitForUngranted(sessionObserver, ['winger-s221-a', 'winger-s221-b'], 2);
    gate.release();
    await gate.hold;
    const settled = await Promise.allSettled([raceA, raceB]);
    expect(settled.every((row) => row.status === 'fulfilled')).toBe(true);
    const values = settled.map(
      (row) =>
        (row as PromiseFulfilledResult<{ legacy: boolean; applied: boolean }>).value,
    );
    expect(values.filter((row) => row.applied).length).toBe(2);

    const after = await financials({
      oicId: line.oicId,
      supplierId,
      retIds: [line.retId, ret2],
    });
    expect(after.clawbackApplied).toBe(2);
    expect(after.appliedAmounts).toEqual([5, 5]);
    expect(after.reversalAmount).toBe(10);
    expect(after.creditBalance).toBe(10);
    expect(after.activeAllocation).toBe(0);
    expect(after.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
  });

  it('E) rollback after proportional writes leaves no partial state; retry once', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('e');
    const line = await seedLine({
      label: 'e',
      supplierId,
      merchandise: 100,
      commission: 10,
    });
    await seedVerifiedAllocation({
      label: 'e',
      supplierId,
      oicId: line.oicId,
      amount: 10,
    });
    await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retId,
        quantity: 1,
        unitPrice: 100,
        lineQuantity: 1,
      }),
    );
    const before = await financials({
      oicId: line.oicId,
      supplierId,
      retIds: [line.retId],
    });
    expect(before.clawbackApplied).toBe(0);
    expect(before.allocationReversals).toBe(0);

    await expect(
      sessionA.$transaction(async (tx) => {
        const result = await ledgerA.applyReturnClawback(tx, {
          returnRequestId: line.retId,
          actor: admin,
        });
        expect(result).toEqual({ legacy: false, applied: true });
        const mid = await tx.commissionClawback.findUniqueOrThrow({
          where: { returnRequestId: line.retId },
        });
        expect(mid.appliedAt).not.toBeNull();
        const credits = await tx.commissionCredit.count({
          where: {
            supplierId,
            reason: CommissionCreditReason.CLAWBACK_AFTER_COLLECTION,
          },
        });
        expect(credits).toBe(1);
        throw new Error('s221-controlled-rollback');
      }),
    ).rejects.toThrow('s221-controlled-rollback');

    const rolled = await financials({
      oicId: line.oicId,
      supplierId,
      retIds: [line.retId],
    });
    expect(rolled).toEqual(before);

    const retry = await sessionA.$transaction((tx) =>
      ledgerA.applyReturnClawback(tx, {
        returnRequestId: line.retId,
        actor: admin,
      }),
    );
    expect(retry).toEqual({ legacy: false, applied: true });
    const after = await financials({
      oicId: line.oicId,
      supplierId,
      retIds: [line.retId],
    });
    expect(after.clawbackApplied).toBe(1);
    expect(after.reversalAmount).toBe(10);
    expect(after.creditBalance).toBe(10);
    expect(after.activeAllocation).toBe(0);
    expect(after.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);

    const again = await sessionA.$transaction((tx) =>
      ledgerA.applyReturnClawback(tx, {
        returnRequestId: line.retId,
        actor: admin,
      }),
    );
    expect(again).toEqual({ legacy: false, applied: false });
    expect(
      await financials({
        oicId: line.oicId,
        supplierId,
        retIds: [line.retId],
      }),
    ).toEqual(after);
  });

  it('F) partial and full proportional returns keep exact amounts and status rules', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('f');
    const line = await seedLine({
      label: 'f',
      supplierId,
      merchandise: 100,
      commission: 10,
      quantity: 2,
    });
    await seedVerifiedAllocation({
      label: 'f',
      supplierId,
      oicId: line.oicId,
      amount: 10,
    });

    const ret2 = `${run}-ret-f2`;
    await sessionA.returnRequest.create({
      data: {
        id: ret2,
        orderId: line.orderId,
        orderItemId: line.itemId,
        customerId,
        reason: 's221-f2',
        quantity: 1,
        status: ReturnRequestStatus.APPROVED,
        refundStatus: ReturnRefundStatus.PENDING,
        refundDrive: ReturnRefundDrive.ATTEMPT,
      } as never,
    });

    await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: line.retId,
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      }),
    );
    const partial = await sessionA.$transaction((tx) =>
      ledgerA.applyReturnClawback(tx, {
        returnRequestId: line.retId,
        actor: admin,
      }),
    );
    expect(partial).toEqual({ legacy: false, applied: true });
    const afterPartial = await financials({
      oicId: line.oicId,
      supplierId,
      retIds: [line.retId],
    });
    expect(afterPartial.appliedAmounts).toEqual([5]);
    expect(afterPartial.reversalAmount).toBe(5);
    expect(afterPartial.creditBalance).toBe(5);
    expect(afterPartial.activeAllocation).toBe(5);
    expect(afterPartial.oicStatus).toBe(CommissionRecognitionStatus.SETTLEABLE);
    expect(afterPartial.activeAllocation).toBeGreaterThanOrEqual(0);
    expect(afterPartial.creditBalance).toBeGreaterThanOrEqual(0);

    await sessionA.$transaction((tx) =>
      ledgerA.reserveReturnClawback(tx, {
        orderItemId: line.itemId,
        returnRequestId: ret2,
        quantity: 1,
        unitPrice: 50,
        lineQuantity: 2,
      }),
    );
    const full = await sessionA.$transaction((tx) =>
      ledgerA.applyReturnClawback(tx, {
        returnRequestId: ret2,
        actor: admin,
      }),
    );
    expect(full).toEqual({ legacy: false, applied: true });
    const afterFull = await financials({
      oicId: line.oicId,
      supplierId,
      retIds: [line.retId, ret2],
    });
    expect(afterFull.appliedAmounts).toEqual([5, 5]);
    expect(afterFull.reversalAmount).toBe(10);
    expect(afterFull.creditBalance).toBe(10);
    expect(afterFull.activeAllocation).toBe(0);
    expect(afterFull.oicStatus).toBe(CommissionRecognitionStatus.CLAWED_BACK);
  });

  it('G) adjustAllocations uses supplier-before-remittance and remains deadlock-free', async () => {
    await assertLiveConnectionIdentity(sessionA);
    const supplierId = await makeSupplier('g');
    const line = await seedLine({
      label: 'g',
      supplierId,
      merchandise: 100,
      commission: 10,
    });
    const remittanceId = await seedVerifiedRemittance({
      label: 'g',
      supplierId,
      amount: 10,
      autoApply: false,
    });

    // Gate holds remittance only. adjustAllocations must take supplier first, then wait.
    let remLocked = false;
    let releaseRem = () => {};
    const remOpen = new Promise<void>((resolve) => {
      releaseRem = resolve;
    });
    const remHold = sessionGate.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "CommissionRemittance" WHERE id = ${remittanceId} FOR UPDATE
        `;
        remLocked = true;
        await remOpen;
      },
      { timeout: 60000 },
    );
    while (!remLocked) await sleep(20);

    const adjustP = ledgerA.adjustAllocations(admin, remittanceId, {
      apply: [{ snapshotId: line.oicId, amount: 10 }],
      reason: 's221-g-adjust',
    });
    await waitForUngranted(sessionObserver, ['winger-s221-a'], 1);

    // While adjust holds supplier and waits on remittance, sweep must wait on supplier.
    const sweepP = ledgerB.sweepSupplier(supplierId);
    await waitForUngranted(sessionObserver, ['winger-s221-a', 'winger-s221-b'], 2);

    releaseRem();
    await remHold;
    const adjusted = await withTimeout(adjustP, 30000, 'adjustAllocations timed out');
    expect(adjusted).toEqual({ ok: true });
    await withTimeout(sweepP, 30000, 'sweep after adjust timed out');

    const alloc = await sessionA.commissionAllocation.findFirst({
      where: {
        remittanceId,
        orderItemCommissionId: line.oicId,
      },
    });
    expect(alloc).toBeTruthy();
    expect(money(alloc!.amountUsd)).toBe(10);
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
