/**
 * S2.6.20.6b — PostgreSQL lease-fence races for worker PAID / FAILED terminals.
 *
 * Opt-in:
 *   $env:S26206_PG_TESTS = "1"
 *   $env:DATABASE_URL = "postgresql://winger:winger@127.0.0.1:5434/winger_s244?schema=public"
 *   npx jest --testPathPattern=payment-reconcile-fence.postgres.integration --runInBand --no-coverage
 *
 * Does NOT rewrite .env. Does NOT target 5433/winger.
 */
import {
  OrderStatus,
  PaymentReconcileManualReviewReason,
  PaymentStatus,
  PrismaClient,
  StockStatus,
  UserRole,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditService } from '../commissions/audit.service';
import { CommissionsService } from '../commissions/commissions.service';
import { OrdersService } from './orders.service';
import {
  PAYMENT_RECONCILE_DEFAULT_LEASE_TTL_MS,
  PaymentReconcileLeaseService,
} from './payment-reconcile-lease.service';
import { utcWallClockIso } from './payment-reconcile-utc';

jest.setTimeout(180000);

const run = `s26206${Date.now().toString(36)}`;
const optedIn = process.env.S26206_PG_TESTS === '1';
const ISOLATED_HOST = '127.0.0.1';
const ISOLATED_PORT = '5434';
const ISOLATED_DB = 'winger_s244';

function assertIsolatedDatabaseUrl(raw: string) {
  if (!raw) {
    throw new Error('DATABASE_URL required for S2.6.20.6b isolated PG tests');
  }
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').split('?')[0];
  if (url.hostname !== ISOLATED_HOST) {
    throw new Error(`Refusing host ${url.hostname}`);
  }
  if (url.port !== ISOLATED_PORT) {
    throw new Error(`Refusing port ${url.port}`);
  }
  if (name !== ISOLATED_DB) {
    throw new Error(`Refusing database ${name}`);
  }
}

function sessionUrl(raw: string, name: string) {
  const url = new URL(raw);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', name);
  return url.toString();
}

async function canConnect(raw: string): Promise<boolean> {
  const db = new PrismaClient({
    datasources: { db: { url: sessionUrl(raw, 'winger-s26206-probe') } },
  });
  try {
    await db.$connect();
    await db.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

type OrdersPrivate = {
  applyValidatedCardSuccess: (params: {
    origin: 'WEBHOOK' | 'RECONCILIATION_WORKER';
    orderId: string;
    customerId: string;
    statusHint: OrderStatus;
    paymentIntentId: string;
    mode: 'test' | 'live';
    leaseOwner?: string;
    nowMs?: number;
  }) => Promise<{ kind: string }>;
  failPendingCardOrder: (params: {
    orderId: string;
    paymentMode: string;
    paymentIntentId?: string;
    actorUserId: string;
    leaseFence?: { leaseOwner: string; nowMs?: number };
  }) => Promise<boolean>;
  claimPaidOrder: (
    orderId: string,
    charge: { mode: string; status: string; paymentIntentId: string; message: string },
    status: OrderStatus,
  ) => Promise<{ count: number }>;
};

function bindOrdersService(prisma: PrismaClient, onOrderPlaced?: jest.Mock) {
  const audit = new AuditService(prisma as never);
  const commissions = new CommissionsService(prisma as never, audit, {} as never);
  const onboarding = {
    onOrderPlaced: onOrderPlaced ?? jest.fn().mockResolvedValue(undefined),
  };
  const orders = Object.create(OrdersService.prototype) as OrdersService;
  Object.assign(orders, {
    prisma,
    stripe: {},
    commissions,
    onboarding,
    audit,
    notifications: {},
    fx: {},
    payouts: {},
    supplierPayments: {},
    ledger: {},
    refundAttempts: {},
    shipmentRefundHolds: {},
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
  });
  return {
    orders,
    priv: orders as unknown as OrdersPrivate,
    onboarding,
    commissions,
  };
}

describe('S2.6.20.6b PostgreSQL fence gate (always runs)', () => {
  it('does not claim concurrency proof without opt-in; fails closed when opted in but DB down', async () => {
    const raw = process.env.DATABASE_URL ?? '';
    if (!optedIn) {
      expect(optedIn).toBe(false);
      return;
    }
    assertIsolatedDatabaseUrl(raw);
    expect(await canConnect(raw)).toBe(true);
  });
});

const concurrencyDescribe = optedIn ? describe : describe.skip;

concurrencyDescribe('PostgreSQL lease-fenced payment terminals (S2.6.20.6b)', () => {
  let sessionA: PrismaClient;
  let sessionB: PrismaClient;
  let sessionGate: PrismaClient;
  let leaseA: PaymentReconcileLeaseService;
  let leaseB: PaymentReconcileLeaseService;
  let customerId = '';
  let supplierId = '';
  let productId = '';
  const orderIds: string[] = [];
  const fixedNow = Date.UTC(2026, 10, 16, 20, 0, 0);

  beforeAll(async () => {
    const raw = process.env.DATABASE_URL ?? '';
    assertIsolatedDatabaseUrl(raw);
    if (!(await canConnect(raw))) {
      throw new Error('S26206_PG_TESTS=1 but isolated PostgreSQL unreachable');
    }
    sessionA = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26206-a') } },
    });
    sessionB = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26206-b') } },
    });
    sessionGate = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s26206-gate') } },
    });
    await Promise.all([
      sessionA.$connect(),
      sessionB.$connect(),
      sessionGate.$connect(),
    ]);

    customerId = `${run}-cust`;
    supplierId = `${run}-sup`;
    productId = `${run}-prod`;
    await sessionGate.user.create({
      data: {
        id: customerId,
        email: `${run}@s26206.invalid`,
        passwordHash: 'x',
        name: 'S26206 Customer',
        role: UserRole.CUSTOMER,
      },
    });
    await sessionGate.supplier.create({
      data: {
        id: supplierId,
        name: 'S26206 Supplier',
        verificationStatus: 'APPROVED',
      },
    });
    await sessionGate.product.create({
      data: {
        id: productId,
        name: 'S26206 Product',
        brand: 'S26206',
        supplierId,
        supplierName: 'S26206 Supplier',
        price: '10',
        stock: 5,
        stockStatus: StockStatus.IN_STOCK,
        imageUrl: 'https://example.invalid/s26206.png',
        category: 's26206-fixture',
      },
    });
    await sessionGate.platformSettings.upsert({
      where: { id: 'default' },
      create: { id: 'default', defaultCommissionPercent: 10 },
      update: { defaultCommissionPercent: 10 },
    });

    leaseA = new PaymentReconcileLeaseService(sessionA as never);
    leaseB = new PaymentReconcileLeaseService(sessionB as never);

    // Additive enum from S2.6.20.9 — safe if already applied.
    await sessionGate.$executeRawUnsafe(
      `ALTER TYPE "PaymentReconcileManualReviewReason" ADD VALUE IF NOT EXISTS 'IDENTITY_MISMATCH'`,
    );
  });

  afterAll(async () => {
    if (!sessionGate) return;
    try {
      if (orderIds.length) {
        await sessionGate.orderItemCommission.deleteMany({
          where: { orderItem: { orderId: { in: orderIds } } },
        });
        await sessionGate.orderItem.deleteMany({
          where: { orderId: { in: orderIds } },
        });
        await sessionGate.inventoryLedger.deleteMany({
          where: { productId },
        });
        await sessionGate.order.deleteMany({ where: { id: { in: orderIds } } });
      }
      await sessionGate.product.deleteMany({ where: { id: productId } });
      await sessionGate.supplier.deleteMany({ where: { id: supplierId } });
      await sessionGate.user.deleteMany({ where: { id: customerId } });
    } finally {
      await Promise.all([
        sessionA?.$disconnect(),
        sessionB?.$disconnect(),
        sessionGate?.$disconnect(),
      ]);
    }
  });

  async function seedPending(opts: {
    idSuffix: string;
    withItem?: boolean;
    piId?: string | null;
  }) {
    const id = `${run}-${opts.idSuffix}-${randomUUID().slice(0, 8)}`;
    orderIds.push(id);
    await sessionGate.order.create({
      data: {
        id,
        displayId: `F6-${randomUUID().slice(0, 10)}`,
        customerId,
        customerEmail: `${run}@s26206.invalid`,
        customerName: 'S26206 Customer',
        status: OrderStatus.PROCESSING,
        paymentStatus: PaymentStatus.PENDING,
        paymentMethod: 'card',
        paymentMode: 'test',
        currency: 'USD',
        paymentCurrency: 'USD',
        subtotal: 10,
        total: 10,
        paymentAmount: 10,
        // Default null so worker/webhook can bind the PI used in the scenario.
        // Bound-only claim filter is covered in the lease PG suite.
        stripePaymentIntentId: opts.piId === undefined ? null : opts.piId,
        paymentReconcileAttemptCount: 0,
      },
    });
    await sessionGate.$executeRaw`
      UPDATE "Order"
      SET "stripeChargeAttemptAt" = ${utcWallClockIso(fixedNow - 10 * 60_000)}::timestamp
      WHERE id = ${id}
    `;
    if (opts.withItem) {
      await sessionGate.orderItem.create({
        data: {
          orderId: id,
          productId,
          productName: 'S26206 Product',
          supplierId,
          supplierName: 'S26206 Supplier',
          unitPrice: 10,
          quantity: 1,
          lineTotal: 10,
          status: OrderStatus.PROCESSING,
        },
      });
    }
    return id;
  }

  async function plantLease(orderId: string, expiresAtMs: number) {
    const token = randomUUID();
    await sessionGate.$executeRaw`
      UPDATE "Order"
      SET
        "paymentReconcileLeaseOwner" = ${token},
        "paymentReconcileLeaseExpiresAt" = ${utcWallClockIso(expiresAtMs)}::timestamp,
        "paymentReconcileAttemptCount" = "paymentReconcileAttemptCount" + 1
      WHERE id = ${orderId}
    `;
    return { id: orderId, leaseOwner: token };
  }

  /** Atomic single-order reclaim using the same expiry predicate as claimEligibleBatch. */
  async function reclaimLease(orderId: string, nowMs: number) {
    const token = randomUUID();
    const nowIso = utcWallClockIso(nowMs);
    const expiresIso = utcWallClockIso(
      nowMs + PAYMENT_RECONCILE_DEFAULT_LEASE_TTL_MS,
    );
    const rows = await sessionGate.$queryRaw<{ id: string }[]>`
      UPDATE "Order"
      SET
        "paymentReconcileLeaseOwner" = ${token},
        "paymentReconcileLeaseExpiresAt" = ${expiresIso}::timestamp,
        "paymentReconcileAttemptCount" = "paymentReconcileAttemptCount" + 1
      WHERE id = ${orderId}
        AND "paymentStatus" = 'PENDING'::"PaymentStatus"
        AND (
          "paymentReconcileLeaseOwner" IS NULL
          OR "paymentReconcileLeaseExpiresAt" IS NULL
          OR "paymentReconcileLeaseExpiresAt" <= ${nowIso}::timestamp
        )
      RETURNING id
    `;
    if (rows.length !== 1) {
      throw new Error(`Failed to reclaim lease for ${orderId}`);
    }
    return { id: orderId, leaseOwner: token };
  }

  it('7+webhook: expiry == now rejects worker; webhook PAID without lease succeeds', async () => {
    const id = await seedPending({ idSuffix: 'eq' });
    const token = randomUUID();
    await sessionGate.$executeRaw`
      UPDATE "Order"
      SET
        "paymentReconcileLeaseOwner" = ${token},
        "paymentReconcileLeaseExpiresAt" = ${utcWallClockIso(fixedNow)}::timestamp
      WHERE id = ${id}
    `;
    const { priv, onboarding } = bindOrdersService(sessionA);
    const worker = await priv.applyValidatedCardSuccess({
      origin: 'RECONCILIATION_WORKER',
      orderId: id,
      customerId,
      statusHint: OrderStatus.PROCESSING,
      paymentIntentId: `pi_eq_${id.slice(-8)}`,
      mode: 'test',
      leaseOwner: token,
      nowMs: fixedNow,
    });
    expect(worker.kind).toBe('lost_race');
    const mid = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(mid.paymentStatus).toBe(PaymentStatus.PENDING);

    const webhook = await priv.applyValidatedCardSuccess({
      origin: 'WEBHOOK',
      orderId: id,
      customerId,
      statusHint: OrderStatus.PROCESSING,
      paymentIntentId: `pi_wh_${id.slice(-8)}`,
      mode: 'test',
    });
    expect(webhook.kind).toBe('claimed');
    expect(onboarding.onOrderPlaced).toHaveBeenCalled();
    const after = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(after.paymentStatus).toBe(PaymentStatus.PAID);
  });

  it('1: A loses lease to B; A fenced PAID rejected', async () => {
    const id = await seedPending({ idSuffix: 'r1' });
    const heldA = await plantLease(id, fixedNow + 60_000);
    expect(await leaseA.isLeaseHeld(id, heldA.leaseOwner, fixedNow + 1)).toBe(
      true,
    );

    await sessionGate.$executeRaw`
      UPDATE "Order"
      SET "paymentReconcileLeaseExpiresAt" = ${utcWallClockIso(fixedNow - 1)}::timestamp
      WHERE id = ${id}
    `;
    const heldB = await reclaimLease(id, fixedNow);
    expect(heldB.leaseOwner).not.toBe(heldA.leaseOwner);

    const { priv, onboarding } = bindOrdersService(sessionA);
    const result = await priv.applyValidatedCardSuccess({
      origin: 'RECONCILIATION_WORKER',
      orderId: id,
      customerId,
      statusHint: OrderStatus.PROCESSING,
      paymentIntentId: `pi_a_${id.slice(-8)}`,
      mode: 'test',
      leaseOwner: heldA.leaseOwner,
      nowMs: fixedNow,
    });
    expect(result.kind).toBe('lost_race');
    expect(onboarding.onOrderPlaced).not.toHaveBeenCalled();
    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(row.paymentReconcileLeaseOwner).toBe(heldB.leaseOwner);
  });

  it('2: A loses lease; A fenced cancel rejected; no stock restore', async () => {
    const id = await seedPending({ idSuffix: 'r2', withItem: true });
    const beforeStock = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    const heldA = await plantLease(id, fixedNow + 60_000);
    await sessionGate.$executeRaw`
      UPDATE "Order"
      SET "paymentReconcileLeaseExpiresAt" = ${utcWallClockIso(fixedNow - 1)}::timestamp
      WHERE id = ${id}
    `;
    const heldB = await reclaimLease(id, fixedNow);
    expect(heldB.leaseOwner).not.toBe(heldA.leaseOwner);

    const { priv } = bindOrdersService(sessionA);
    const failed = await priv.failPendingCardOrder({
      orderId: id,
      paymentMode: 'test',
      paymentIntentId: `pi_c_${id.slice(-8)}`,
      actorUserId: customerId,
      leaseFence: { leaseOwner: heldA.leaseOwner, nowMs: fixedNow },
    });
    expect(failed).toBe(false);
    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(row.paymentReconcileLeaseOwner).toBe(heldB.leaseOwner);
    const afterStock = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    expect(afterStock).toBe(beforeStock);
  });

  it('3: webhook PAID wins over worker cancel; no stock restore', async () => {
    const id = await seedPending({ idSuffix: 'r3', withItem: true });
    const beforeStock = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    const held = await plantLease(id, fixedNow + 60_000);
    const pi = `pi_r3_${id.slice(-8)}`;

    const webhookSvc = bindOrdersService(sessionB);
    const wh = await webhookSvc.priv.applyValidatedCardSuccess({
      origin: 'WEBHOOK',
      orderId: id,
      customerId,
      statusHint: OrderStatus.PROCESSING,
      paymentIntentId: pi,
      mode: 'test',
    });
    expect(wh.kind).toBe('claimed');

    const workerSvc = bindOrdersService(sessionA);
    const failed = await workerSvc.priv.failPendingCardOrder({
      orderId: id,
      paymentMode: 'test',
      paymentIntentId: pi,
      actorUserId: customerId,
      leaseFence: { leaseOwner: held.leaseOwner, nowMs: fixedNow },
    });
    expect(failed).toBe(false);
    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentStatus).toBe(PaymentStatus.PAID);
    const afterStock = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    expect(afterStock).toBe(beforeStock);
  });

  it('4: worker and webhook both attempt PAID — one success; snapshots idempotent', async () => {
    const id = await seedPending({ idSuffix: 'r4', withItem: true });
    const held = await plantLease(id, fixedNow + 60_000);
    const pi = `pi_r4_${id.slice(-8)}`;
    const item = await sessionGate.orderItem.findFirstOrThrow({
      where: { orderId: id },
    });

    const workerOnboard = jest.fn().mockResolvedValue(undefined);
    const webhookOnboard = jest.fn().mockResolvedValue(undefined);
    const workerSvc = bindOrdersService(sessionA, workerOnboard);
    const webhookSvc = bindOrdersService(sessionB, webhookOnboard);

    const [w, h] = await Promise.all([
      workerSvc.priv.applyValidatedCardSuccess({
        origin: 'RECONCILIATION_WORKER',
        orderId: id,
        customerId,
        statusHint: OrderStatus.PROCESSING,
        paymentIntentId: pi,
        mode: 'test',
        leaseOwner: held.leaseOwner,
        nowMs: fixedNow,
      }),
      webhookSvc.priv.applyValidatedCardSuccess({
        origin: 'WEBHOOK',
        orderId: id,
        customerId,
        statusHint: OrderStatus.PROCESSING,
        paymentIntentId: pi,
        mode: 'test',
      }),
    ]);

    const claimedCount = [w.kind, h.kind].filter((k) => k === 'claimed').length;
    expect(claimedCount).toBe(1);
    expect([w.kind, h.kind]).toEqual(
      expect.arrayContaining(['claimed']),
    );
    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentStatus).toBe(PaymentStatus.PAID);
    expect(row.stripePaymentIntentId).toBe(pi);

    const commissions = await sessionGate.orderItemCommission.findMany({
      where: { orderItemId: item.id },
    });
    expect(commissions).toHaveLength(1);
    const commissionsForOrder = await sessionGate.orderItemCommission.findMany({
      where: { orderItem: { orderId: id } },
    });
    expect(commissionsForOrder).toHaveLength(1);

    expect(workerOnboard.mock.calls.length + webhookOnboard.mock.calls.length).toBe(
      1,
    );
  });

  it('5: valid lease + validated PI → worker PAID and clears lease', async () => {
    const id = await seedPending({ idSuffix: 'r5' });
    const held = await plantLease(id, fixedNow + 60_000);
    const pi = `pi_r5_${id.slice(-8)}`;
    const { priv, onboarding } = bindOrdersService(sessionA);
    const result = await priv.applyValidatedCardSuccess({
      origin: 'RECONCILIATION_WORKER',
      orderId: id,
      customerId,
      statusHint: OrderStatus.PROCESSING,
      paymentIntentId: pi,
      mode: 'test',
      leaseOwner: held.leaseOwner,
      nowMs: fixedNow,
    });
    expect(result.kind).toBe('claimed');
    expect(onboarding.onOrderPlaced).toHaveBeenCalledTimes(1);
    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentStatus).toBe(PaymentStatus.PAID);
    expect(row.paymentReconcileLeaseOwner).toBeNull();
    expect(row.paymentReconcileLeaseExpiresAt).toBeNull();
    expect(row.stripePaymentIntentId).toBe(pi);
  });

  it('6: lease lost during retrieval window → terminal mutation rejected', async () => {
    const id = await seedPending({ idSuffix: 'r6' });
    const held = await plantLease(id, fixedNow + 60_000);
    await sessionGate.$executeRaw`
      UPDATE "Order"
      SET "paymentReconcileLeaseExpiresAt" = ${utcWallClockIso(fixedNow - 1)}::timestamp
      WHERE id = ${id}
    `;
    await reclaimLease(id, fixedNow);

    const { priv, onboarding } = bindOrdersService(sessionA);
    const result = await priv.applyValidatedCardSuccess({
      origin: 'RECONCILIATION_WORKER',
      orderId: id,
      customerId,
      statusHint: OrderStatus.PROCESSING,
      paymentIntentId: `pi_r6_${id.slice(-8)}`,
      mode: 'test',
      leaseOwner: held.leaseOwner,
      nowMs: fixedNow,
    });
    expect(result.kind).toBe('lost_race');
    expect(onboarding.onOrderPlaced).not.toHaveBeenCalled();
    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentStatus).toBe(PaymentStatus.PENDING);
  });

  it('9a: public worker façades honor the same PAID / cancel fences', async () => {
    const paidId = await seedPending({ idSuffix: 'facade-paid' });
    const paidLease = await plantLease(paidId, fixedNow + 60_000);
    const paidPi = `pi_fp_${paidId.slice(-8)}`;
    const { orders: paidOrders, onboarding } = bindOrdersService(sessionA);
    const paid = await paidOrders.applyWorkerCardSuccess({
      orderId: paidId,
      customerId,
      statusHint: OrderStatus.PROCESSING,
      paymentIntentId: paidPi,
      mode: 'test',
      leaseOwner: paidLease.leaseOwner,
      nowMs: fixedNow,
    });
    expect(paid.kind).toBe('claimed');
    expect(onboarding.onOrderPlaced).toHaveBeenCalledTimes(1);

    const cancelId = await seedPending({
      idSuffix: 'facade-cancel',
      withItem: true,
    });
    const beforeStock = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    const cancelLease = await plantLease(cancelId, fixedNow + 60_000);
    const { orders: cancelOrders } = bindOrdersService(sessionB);
    const failed = await cancelOrders.failWorkerCardOrder({
      orderId: cancelId,
      paymentMode: 'test',
      paymentIntentId: `pi_fc_${cancelId.slice(-8)}`,
      actorUserId: customerId,
      leaseOwner: cancelLease.leaseOwner,
      nowMs: fixedNow,
    });
    expect(failed).toBe(true);
    const afterStock = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    expect(afterStock).toBe(beforeStock + 1);

    // Lost lease → façade cancel rejected, no stock restore beyond prior.
    const lostId = await seedPending({ idSuffix: 'facade-lost', withItem: true });
    const stockMid = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    const lostLease = await plantLease(lostId, fixedNow + 60_000);
    await sessionGate.$executeRaw`
      UPDATE "Order"
      SET "paymentReconcileLeaseExpiresAt" = ${utcWallClockIso(fixedNow - 1)}::timestamp
      WHERE id = ${lostId}
    `;
    await reclaimLease(lostId, fixedNow);
    const rejected = await cancelOrders.failWorkerCardOrder({
      orderId: lostId,
      paymentMode: 'test',
      paymentIntentId: `pi_fl_${lostId.slice(-8)}`,
      actorUserId: customerId,
      leaseOwner: lostLease.leaseOwner,
      nowMs: fixedNow,
    });
    expect(rejected).toBe(false);
    const stockEnd = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    expect(stockEnd).toBe(stockMid);
  });

  it('9a: IDENTITY_MISMATCH after lease loss does not overwrite state', async () => {
    const id = await seedPending({ idSuffix: 'id-mismatch' });
    const heldA = await plantLease(id, fixedNow + 60_000);
    await sessionGate.$executeRaw`
      UPDATE "Order"
      SET "paymentReconcileLeaseExpiresAt" = ${utcWallClockIso(fixedNow - 1)}::timestamp
      WHERE id = ${id}
    `;
    const heldB = await reclaimLease(id, fixedNow);

    const marked = await leaseA.markManualReview({
      orderId: id,
      leaseOwner: heldA.leaseOwner,
      reason: PaymentReconcileManualReviewReason.IDENTITY_MISMATCH,
      nowMs: fixedNow,
    });
    expect(marked).toBe(false);
    const row = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(row.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(row.paymentReconcileManualReviewAt).toBeNull();
    expect(row.paymentReconcileLeaseOwner).toBe(heldB.leaseOwner);

    const ok = await leaseB.markManualReview({
      orderId: id,
      leaseOwner: heldB.leaseOwner,
      reason: PaymentReconcileManualReviewReason.IDENTITY_MISMATCH,
      nowMs: fixedNow,
    });
    expect(ok).toBe(true);
    const after = await sessionGate.order.findUniqueOrThrow({ where: { id } });
    expect(after.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(after.paymentReconcileManualReviewReason).toBe(
      PaymentReconcileManualReviewReason.IDENTITY_MISMATCH,
    );
    expect(after.paymentReconcileLeaseOwner).toBeNull();
  });
});
