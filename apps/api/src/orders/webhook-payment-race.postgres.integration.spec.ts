/**
 * S2.6.18.12 / S2.6.18.13 — PostgreSQL two-session races for succeeded-webhook claim-first.
 *
 * Opt-in (fails closed when set but DB unreachable):
 *   $env:S261812_PG_TESTS = "1"
 *   $env:DATABASE_URL = "postgresql://winger:winger@127.0.0.1:5434/winger_s244?schema=public"
 *   npx jest --testPathPattern=webhook-payment-race.postgres.integration --runInBand --no-coverage
 *
 * Stripe network I/O is mocked. Commission snapshots use real CommissionsService → DB rows.
 * Does NOT modify .env. Does NOT target 5433/winger.
 */
import {
  CommissionRecognitionStatus,
  OrderStatus,
  PaymentStatus,
  PrismaClient,
  StockStatus,
  UserRole,
} from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import { AuditService } from '../commissions/audit.service';
import { CommissionsService } from '../commissions/commissions.service';
import { OrdersService } from './orders.service';

jest.setTimeout(180000);

const run = `s261813${Date.now().toString(36)}`;
const optedIn = process.env.S261812_PG_TESTS === '1';
const ISOLATED_HOST = '127.0.0.1';
const ISOLATED_PORT = '5434';
const ISOLATED_DB = 'winger_s244';

function assertIsolatedDatabaseUrl(raw: string) {
  if (!raw) {
    throw new Error('DATABASE_URL is required for S2.6.18.13 isolated PG tests');
  }
  const url = new URL(raw);
  const name = url.pathname.replace(/^\//, '').split('?')[0];
  if (url.hostname !== ISOLATED_HOST) {
    throw new Error(`Refusing host ${url.hostname}; expected ${ISOLATED_HOST}`);
  }
  if (url.port !== ISOLATED_PORT) {
    throw new Error(`Refusing port ${url.port}; expected ${ISOLATED_PORT}`);
  }
  if (name !== ISOLATED_DB) {
    throw new Error(`Refusing database ${name}; expected ${ISOLATED_DB}`);
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
    datasources: { db: { url: sessionUrl(raw, 'winger-s261813-probe') } },
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

describe('S2.6.18.13 PostgreSQL gate (always runs)', () => {
  it('does not claim concurrency proof without opt-in; fails closed when opted in but DB down', async () => {
    const raw = process.env.DATABASE_URL ?? '';
    if (!optedIn) {
      expect(optedIn).toBe(false);
      return;
    }
    assertIsolatedDatabaseUrl(raw);
    const reachable = await canConnect(raw);
    expect(reachable).toBe(true);
  });
});

const concurrencyDescribe = optedIn ? describe : describe.skip;

type StripeWebhookMock = {
  retrievePaymentIntentForWebhook: jest.Mock;
  retrievePaymentIntentStatus: jest.Mock;
  refundCardCharge: jest.Mock;
  chargeOrder: jest.Mock;
  confirmPaymentIntent: jest.Mock;
  checkoutMode: string;
};

function succeededIntent(orderId: string, piId: string) {
  return {
    ok: true as const,
    intent: {
      id: piId,
      status: 'succeeded',
      amount: 5899,
      amountReceived: 5899,
      currency: 'usd',
      livemode: false,
      metadataOrderId: orderId,
    },
  };
}

function canceledIntent(orderId: string, piId: string) {
  return {
    ok: true as const,
    intent: {
      id: piId,
      status: 'canceled',
      amount: 5899,
      amountReceived: null,
      currency: 'usd',
      livemode: false,
      metadataOrderId: orderId,
    },
  };
}

function bindOrdersService(params: {
  prisma: PrismaClient;
  stripe: StripeWebhookMock;
  onOrderPlaced?: jest.Mock;
}) {
  const audit = new AuditService(params.prisma as never);
  const commissions = new CommissionsService(
    params.prisma as never,
    audit,
    {} as never,
  );
  const onboarding = {
    onOrderPlaced: params.onOrderPlaced ?? jest.fn().mockResolvedValue(undefined),
    onSupplierShipped: jest.fn().mockResolvedValue(undefined),
  };
  const orders = Object.create(OrdersService.prototype) as OrdersService;
  Object.assign(orders, {
    prisma: params.prisma,
    stripe: params.stripe,
    commissions,
    onboarding,
    audit,
    notifications: { notifyReturnStatusChange: jest.fn() },
    fx: {},
    payouts: { transferIfSettleable: jest.fn(), reverseIfTransferred: jest.fn() },
    supplierPayments: { checkoutLipa: jest.fn() },
    ledger: {},
    refundAttempts: {},
    shipmentRefundHolds: {},
    logger: { warn: jest.fn(), log: jest.fn(), error: jest.fn() },
  });
  return { orders, commissions, onboarding, audit };
}

/**
 * Pause the first claimPaidOrder invocation until release().
 * Signals when that claim entry point is reached (after validate/associate).
 */
function installFirstClaimBarrier(orders: OrdersService) {
  const original = (
    OrdersService.prototype as unknown as {
      claimPaidOrder: (
        this: OrdersService,
        ...args: unknown[]
      ) => Promise<{ count: number }>;
    }
  ).claimPaidOrder;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let invocations = 0;

  (
    orders as unknown as {
      claimPaidOrder: (...args: unknown[]) => Promise<{ count: number }>;
    }
  ).claimPaidOrder = async function claimBarrier(
    this: OrdersService,
    ...args: unknown[]
  ) {
    invocations += 1;
    if (invocations === 1) {
      signalEntered();
      await gate;
    }
    return original.apply(this, args as never);
  };

  return {
    entered,
    release: () => releaseGate(),
    invocations: () => invocations,
  };
}

concurrencyDescribe('PostgreSQL webhook payment races (S2.6.18.13)', () => {
  let sessionA: PrismaClient;
  let sessionB: PrismaClient;
  let sessionGate: PrismaClient;
  let customerId = '';
  let supplierId = '';
  let productId = '';
  const orderIds: string[] = [];
  const customer: AuthUser = {
    sub: '',
    email: '',
    name: 'S261813 Customer',
    role: UserRole.CUSTOMER,
  };

  beforeAll(async () => {
    const raw = process.env.DATABASE_URL ?? '';
    assertIsolatedDatabaseUrl(raw);
    const reachable = await canConnect(raw);
    if (!reachable) {
      throw new Error(
        `S261812_PG_TESTS=1 but PostgreSQL unreachable at ${ISOLATED_HOST}:${ISOLATED_PORT}/${ISOLATED_DB}`,
      );
    }
    sessionA = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s261813-a') } },
    });
    sessionB = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s261813-b') } },
    });
    sessionGate = new PrismaClient({
      datasources: { db: { url: sessionUrl(raw, 'winger-s261813-gate') } },
    });
    await Promise.all([
      sessionA.$connect(),
      sessionB.$connect(),
      sessionGate.$connect(),
    ]);

    supplierId = `${run}-sup`;
    await sessionGate.supplier.create({
      data: {
        id: supplierId,
        name: 'S261813 Supplier',
        verificationStatus: 'APPROVED',
      },
    });
    customerId = `${run}-cust`;
    customer.sub = customerId;
    customer.email = `${run}@s261813.invalid`;
    await sessionGate.user.create({
      data: {
        id: customerId,
        email: customer.email,
        passwordHash: 'fixture-not-a-login',
        name: customer.name,
        role: UserRole.CUSTOMER,
      },
    });
    productId = `${run}-p1`;
    await sessionGate.product.create({
      data: {
        id: productId,
        name: 'Race Product',
        brand: 'S261813',
        supplierId,
        supplierName: 'S261813 Supplier',
        price: '58.99',
        stock: 10,
        stockStatus: StockStatus.IN_STOCK,
        imageUrl: 'https://example.invalid/s261813.png',
        category: 's261813-fixture',
      },
    });
    await sessionGate.platformSettings.upsert({
      where: { id: 'default' },
      create: {
        id: 'default',
        defaultCommissionPercent: 10,
      },
      update: { defaultCommissionPercent: 10 },
    });
  });

  afterAll(async () => {
    if (!sessionGate) return;
    try {
      await sessionGate.orderItemCommission.deleteMany({
        where: { orderItem: { orderId: { in: orderIds } } },
      });
      await sessionGate.inventoryLedger.deleteMany({
        where: { productId },
      });
      await sessionGate.orderItem.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await sessionGate.order.deleteMany({ where: { id: { in: orderIds } } });
      await sessionGate.product.deleteMany({ where: { id: productId } });
      await sessionGate.user.deleteMany({ where: { id: customerId } });
      await sessionGate.supplier.deleteMany({ where: { id: supplierId } });
    } finally {
      await Promise.all([
        sessionA?.$disconnect(),
        sessionB?.$disconnect(),
        sessionGate?.$disconnect(),
      ]);
    }
  });

  async function seedPendingOrder(input: {
    piId: string | null;
    checkoutKey?: string;
    startingStock?: number;
  }) {
    const orderId = `${run}-ord-${Math.random().toString(36).slice(2, 8)}`;
    const itemId = `${run}-oi-${Math.random().toString(36).slice(2, 8)}`;
    orderIds.push(orderId);

    // Reset product stock for deterministic assertions.
    const stock = input.startingStock ?? 10;
    await sessionGate.product.update({
      where: { id: productId },
      data: { stock, stockStatus: StockStatus.IN_STOCK },
    });

    await sessionGate.order.create({
      data: {
        id: orderId,
        displayId: `WG-${orderId.slice(-6)}`,
        customerId,
        customerEmail: customer.email,
        customerName: customer.name,
        status: OrderStatus.PROCESSING,
        paymentStatus: PaymentStatus.PENDING,
        paymentMethod: 'card',
        paymentMode: 'test',
        currency: 'USD',
        paymentCurrency: 'USD',
        subtotal: 58.99,
        total: 58.99,
        paymentAmount: 58.99,
        stripePaymentIntentId: input.piId,
        checkoutIdempotencyKey: input.checkoutKey ?? null,
        stripeChargeAttemptAt: input.checkoutKey ? new Date() : null,
      } as never,
    });
    await sessionGate.orderItem.create({
      data: {
        id: itemId,
        orderId,
        productId,
        productName: 'Race Product',
        supplierId,
        supplierName: 'S261813 Supplier',
        quantity: 1,
        unitPrice: 58.99,
        lineTotal: 58.99,
        status: OrderStatus.PROCESSING,
      },
    });
    // Checkout already reserved one unit.
    await sessionGate.product.update({
      where: { id: productId },
      data: { stock: { decrement: 1 } },
    });

    return sessionGate.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: true },
    });
  }

  async function assertSingleCommission(orderId: string) {
    const rows = await sessionGate.orderItemCommission.findMany({
      where: { orderItem: { orderId } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].paymentMode).toBe('test');
    expect(rows[0].isDemo).toBe(true);
    expect(rows[0].status).toBe(CommissionRecognitionStatus.RECOGNIZED);
    // 10% of 58.99 → 5.90
    expect(Number(rows[0].commissionAmount)).toBeCloseTo(5.9, 2);
    return rows[0];
  }

  it('concurrent createSnapshotsForOrder for the same order is idempotent', async () => {
    const order = await seedPendingOrder({ piId: `pi_${run}_snap` });
    const audit = new AuditService(sessionA as never);
    const commissionsA = new CommissionsService(
      sessionA as never,
      audit,
      {} as never,
    );
    const commissionsB = new CommissionsService(
      sessionB as never,
      new AuditService(sessionB as never),
      {} as never,
    );
    const params = {
      orderId: order.id,
      paymentMode: 'test',
      isDemo: true,
      initialStatus: CommissionRecognitionStatus.RECOGNIZED,
    } as const;

    const [a, b] = await Promise.all([
      commissionsA.createSnapshotsForOrder(params),
      commissionsB.createSnapshotsForOrder(params),
    ]);
    expect(a.created + b.created).toBe(1);
    expect(a.created + a.skipped).toBe(1);
    expect(b.created + b.skipped).toBe(1);
    await assertSingleCommission(order.id);
  });

  it('Race A: barrier — succeeded pauses before claim; canceled fail completes; succeeded recovers', async () => {
    const piId = `pi_${run}_a`;
    const order = await seedPendingOrder({ piId });
    const stockAfterReserve = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    expect(stockAfterReserve).toBe(9);

    const stripeOk: StripeWebhookMock = {
      retrievePaymentIntentForWebhook: jest
        .fn()
        .mockResolvedValue(succeededIntent(order.id, piId)),
      retrievePaymentIntentStatus: jest.fn(),
      refundCardCharge: jest.fn(),
      chargeOrder: jest.fn(),
      confirmPaymentIntent: jest.fn(),
      checkoutMode: 'test',
    };
    const stripeFail: StripeWebhookMock = {
      retrievePaymentIntentForWebhook: jest
        .fn()
        .mockResolvedValue(canceledIntent(order.id, piId)),
      retrievePaymentIntentStatus: jest.fn(),
      refundCardCharge: jest.fn(),
      chargeOrder: jest.fn(),
      confirmPaymentIntent: jest.fn(),
      checkoutMode: 'test',
    };
    const onboardA = jest.fn().mockResolvedValue(undefined);
    const onboardB = jest.fn().mockResolvedValue(undefined);
    const { orders: ordersA } = bindOrdersService({
      prisma: sessionA,
      stripe: stripeOk,
      onOrderPlaced: onboardA,
    });
    const { orders: ordersB } = bindOrdersService({
      prisma: sessionB,
      stripe: stripeFail,
      onOrderPlaced: onboardB,
    });

    const barrier = installFirstClaimBarrier(ordersA);
    const succeededPromise = ordersA.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: piId, metadata: { orderId: order.id } } },
    } as never);

    await barrier.entered;

    // Succeeded path has passed validate/associate and is blocked before claim.
    const midBound = await sessionGate.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(midBound.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(midBound.stripePaymentIntentId).toBe(piId);

    const failed = await ordersB.handleStripeEvent({
      type: 'payment_intent.payment_failed',
      livemode: false,
      data: { object: { id: piId, metadata: { orderId: order.id } } },
    } as never);
    expect(failed).toMatchObject({ failed: true });

    const afterFail = await sessionGate.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(afterFail.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(afterFail.status).toBe(OrderStatus.CANCELLED);
    const stockAfterFail = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    expect(stockAfterFail).toBe(10);

    barrier.release();
    const succeeded = await succeededPromise;
    expect(succeeded).toMatchObject({ recovered: true });

    const final = await sessionGate.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(final.paymentStatus).toBe(PaymentStatus.PAID);
    expect(final.status).toBe(OrderStatus.PROCESSING);
    expect(final.stripePaymentIntentId).toBe(piId);
    const stockFinal = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    expect(stockFinal).toBe(9);
    await assertSingleCommission(order.id);
    expect(onboardA).toHaveBeenCalledTimes(1);
    expect(onboardB).not.toHaveBeenCalled();
  });

  it('Race B: two concurrent succeeded webhooks — one PAID, one commission, stock held once', async () => {
    const piId = `pi_${run}_b`;
    const order = await seedPendingOrder({ piId });
    const makeStripe = (): StripeWebhookMock => ({
      retrievePaymentIntentForWebhook: jest
        .fn()
        .mockResolvedValue(succeededIntent(order.id, piId)),
      retrievePaymentIntentStatus: jest.fn(),
      refundCardCharge: jest.fn(),
      chargeOrder: jest.fn(),
      confirmPaymentIntent: jest.fn(),
      checkoutMode: 'test',
    });
    const onboardA = jest.fn().mockResolvedValue(undefined);
    const onboardB = jest.fn().mockResolvedValue(undefined);
    const { orders: ordersA } = bindOrdersService({
      prisma: sessionA,
      stripe: makeStripe(),
      onOrderPlaced: onboardA,
    });
    const { orders: ordersB } = bindOrdersService({
      prisma: sessionB,
      stripe: makeStripe(),
      onOrderPlaced: onboardB,
    });

    const event = {
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: piId, metadata: { orderId: order.id } } },
    } as never;

    const [r1, r2] = await Promise.all([
      ordersA.handleStripeEvent(event),
      ordersB.handleStripeEvent(event),
    ]);

    // Both webhooks must complete successfully (no uncaught unique-constraint).
    const outcomes = [r1, r2];
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ received: true });
    }
    const paidWins = outcomes.filter(
      (o) =>
        o &&
        typeof o === 'object' &&
        !('duplicate' in o && (o as { duplicate?: boolean }).duplicate),
    );
    const duplicates = outcomes.filter(
      (o) =>
        o &&
        typeof o === 'object' &&
        (o as { duplicate?: boolean }).duplicate === true,
    );
    expect(paidWins).toHaveLength(1);
    expect(duplicates).toHaveLength(1);

    const final = await sessionGate.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(final.paymentStatus).toBe(PaymentStatus.PAID);
    expect(final.status).toBe(OrderStatus.PROCESSING);
    expect(final.stripePaymentIntentId).toBe(piId);
    const stock = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    expect(stock).toBe(9);
    await assertSingleCommission(order.id);
    expect(onboardA.mock.calls.length + onboardB.mock.calls.length).toBe(1);
  });

  it('Race C: succeeded webhook versus real create()/resumeCheckout retry', async () => {
    const piId = `pi_${run}_c`;
    const checkoutKey = `chk_${run}_c_key12`;
    const order = await seedPendingOrder({ piId, checkoutKey });

    const stripeWebhook: StripeWebhookMock = {
      retrievePaymentIntentForWebhook: jest
        .fn()
        .mockResolvedValue(succeededIntent(order.id, piId)),
      retrievePaymentIntentStatus: jest.fn().mockResolvedValue({
        ok: true,
        id: piId,
        status: 'succeeded',
      }),
      refundCardCharge: jest.fn(),
      chargeOrder: jest.fn(),
      confirmPaymentIntent: jest.fn(),
      checkoutMode: 'test',
    };
    const stripeCheckout: StripeWebhookMock = {
      retrievePaymentIntentForWebhook: jest.fn(),
      retrievePaymentIntentStatus: jest.fn().mockResolvedValue({
        ok: true,
        id: piId,
        status: 'succeeded',
      }),
      refundCardCharge: jest.fn(),
      chargeOrder: jest.fn(),
      confirmPaymentIntent: jest.fn(),
      checkoutMode: 'test',
    };
    const onboardA = jest.fn().mockResolvedValue(undefined);
    const onboardB = jest.fn().mockResolvedValue(undefined);
    const { orders: ordersWebhook } = bindOrdersService({
      prisma: sessionA,
      stripe: stripeWebhook,
      onOrderPlaced: onboardA,
    });
    const { orders: ordersCheckout } = bindOrdersService({
      prisma: sessionB,
      stripe: stripeCheckout,
      onOrderPlaced: onboardB,
    });

    const barrier = installFirstClaimBarrier(ordersWebhook);
    const webhookPromise = ordersWebhook.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: piId, metadata: { orderId: order.id } } },
    } as never);
    await barrier.entered;

    // Actual checkout retry entry: create() → resumeCheckout → reconcileKnownPaymentIntent.
    const checkoutPromise = ordersCheckout.create(
      {
        items: [{ productId, quantity: 1 }],
        paymentMethod: 'card',
        checkoutIdempotencyKey: checkoutKey,
        stripePaymentMethodId: 'pm_card_race_c',
      },
      customer,
    );

    // Let checkout race the claim while webhook is still gated, then release.
    await new Promise((r) => setImmediate(r));
    barrier.release();

    const [webhookResult, checkoutResult] = await Promise.all([
      webhookPromise,
      checkoutPromise,
    ]);

    expect(webhookResult).toBeTruthy();
    expect(checkoutResult.paymentStatus).toBe(PaymentStatus.PAID);
    expect(stripeCheckout.chargeOrder).not.toHaveBeenCalled();
    expect(stripeWebhook.chargeOrder).not.toHaveBeenCalled();

    const final = await sessionGate.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(final.paymentStatus).toBe(PaymentStatus.PAID);
    expect(final.stripePaymentIntentId).toBe(piId);
    expect(final.paymentStatus).not.toBe(PaymentStatus.FAILED);
    const stock = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    expect(stock).toBe(9);
    await assertSingleCommission(order.id);
    expect(onboardA.mock.calls.length + onboardB.mock.calls.length).toBe(1);
  });

  it('Race D: concurrent different PaymentIntent IDs — only first bind wins', async () => {
    const order = await seedPendingOrder({ piId: null });
    const piFirst = `pi_${run}_d1`;
    const piSecond = `pi_${run}_d2`;

    const makeStripe = (pi: string): StripeWebhookMock => ({
      retrievePaymentIntentForWebhook: jest
        .fn()
        .mockResolvedValue(succeededIntent(order.id, pi)),
      retrievePaymentIntentStatus: jest.fn(),
      refundCardCharge: jest.fn(),
      chargeOrder: jest.fn(),
      confirmPaymentIntent: jest.fn(),
      checkoutMode: 'test',
    });
    const onboardA = jest.fn().mockResolvedValue(undefined);
    const onboardB = jest.fn().mockResolvedValue(undefined);
    const { orders: ordersA } = bindOrdersService({
      prisma: sessionA,
      stripe: makeStripe(piFirst),
      onOrderPlaced: onboardA,
    });
    const { orders: ordersB } = bindOrdersService({
      prisma: sessionB,
      stripe: makeStripe(piSecond),
      onOrderPlaced: onboardB,
    });

    // Barrier both first claims so association races while both still unbound.
    const barrierA = installFirstClaimBarrier(ordersA);
    const barrierB = installFirstClaimBarrier(ordersB);

    const pA = ordersA.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: piFirst, metadata: { orderId: order.id } } },
    } as never);
    const pB = ordersB.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: piSecond, metadata: { orderId: order.id } } },
    } as never);

    await Promise.race([barrierA.entered, barrierB.entered]);
    // Allow the other path to finish associate (null-only) before either claims.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    barrierA.release();
    barrierB.release();
    const [r1, r2] = await Promise.all([pA, pB]);

    const final = await sessionGate.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(final.paymentStatus).toBe(PaymentStatus.PAID);
    expect([piFirst, piSecond]).toContain(final.stripePaymentIntentId);
    const winnerPi = final.stripePaymentIntentId!;

    const ignoredOrMismatch = [r1, r2].filter(
      (o) =>
        o &&
        typeof o === 'object' &&
        ((o as { ignored?: boolean }).ignored ||
          (o as { reason?: string }).reason === 'pi_mismatch'),
    );
    expect(ignoredOrMismatch.length).toBeGreaterThanOrEqual(1);

    const stock = (
      await sessionGate.product.findUniqueOrThrow({ where: { id: productId } })
    ).stock;
    expect(stock).toBe(9);
    await assertSingleCommission(order.id);
    expect(onboardA.mock.calls.length + onboardB.mock.calls.length).toBe(1);

    // Loser must not have left a second commission or alternate PI paid.
    const commissions = await sessionGate.orderItemCommission.findMany({
      where: { orderItem: { orderId: order.id } },
    });
    expect(commissions).toHaveLength(1);
    expect(final.stripePaymentIntentId).toBe(winnerPi);
  });
});
