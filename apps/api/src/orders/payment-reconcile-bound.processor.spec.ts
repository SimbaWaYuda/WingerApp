import {
  OrderStatus,
  PaymentReconcileManualReviewReason,
  PaymentStatus,
} from '@prisma/client';
import { OrdersService } from './orders.service';
import { PaymentReconcileBoundProcessor } from './payment-reconcile-bound.processor';
import {
  PAYMENT_RECONCILE_MAX_CLAIMS,
  PaymentReconcileClaimedOrder,
} from './payment-reconcile-lease.service';
import {
  paymentReconcileBackoffMs,
  PaymentReconcileWorkContext,
  PaymentReconcileWorker,
} from './payment-reconcile.worker';

const FIXED_NOW = Date.UTC(2026, 10, 16, 12, 0, 0);

function claimed(
  overrides: Partial<PaymentReconcileClaimedOrder> = {},
): PaymentReconcileClaimedOrder {
  return {
    id: 'ord-1',
    leaseOwner: 'lease-a',
    leaseExpiresAt: new Date(FIXED_NOW + 5 * 60_000),
    attemptCount: 1,
    paymentMode: 'test',
    stripePaymentIntentId: 'pi_bound',
    stripeChargeAttemptAt: new Date(FIXED_NOW - 10 * 60_000),
    paymentReconcileNextAt: null,
    ...overrides,
  };
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_bound',
    status: 'succeeded',
    amount: 1000,
    amountReceived: 1000,
    currency: 'usd',
    livemode: false,
    metadataOrderId: 'ord-1',
    ...overrides,
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    customerId: 'cust-1',
    status: OrderStatus.PROCESSING,
    paymentStatus: PaymentStatus.PENDING,
    paymentMode: 'test',
    stripePaymentIntentId: 'pi_bound',
    paymentAmount: 10,
    paymentCurrency: 'USD',
    currency: 'USD',
    total: 10,
    ...overrides,
  };
}

function makeCtx(
  order: PaymentReconcileClaimedOrder,
  opts?: { invalidated?: boolean },
): PaymentReconcileWorkContext {
  let invalidated = opts?.invalidated === true;
  return {
    order,
    get invalidated() {
      return invalidated;
    },
    invalidate: () => {
      invalidated = true;
    },
    canApplyTerminal: () => !invalidated,
  };
}

describe('OrdersService worker façades (S2.6.20.9b)', () => {
  it('applyWorkerCardSuccess delegates to RECONCILIATION_WORKER origin', async () => {
    const applyValidatedCardSuccess = jest
      .fn()
      .mockResolvedValue({ kind: 'claimed' });
    const svc = Object.create(OrdersService.prototype) as OrdersService;
    Object.assign(svc, { applyValidatedCardSuccess });
    await svc.applyWorkerCardSuccess({
      orderId: 'ord-1',
      customerId: 'cust-1',
      statusHint: OrderStatus.PROCESSING,
      paymentIntentId: 'pi_1',
      mode: 'test',
      leaseOwner: 'lease-a',
      nowMs: FIXED_NOW,
    });
    expect(applyValidatedCardSuccess).toHaveBeenCalledWith({
      origin: 'RECONCILIATION_WORKER',
      orderId: 'ord-1',
      customerId: 'cust-1',
      statusHint: OrderStatus.PROCESSING,
      paymentIntentId: 'pi_1',
      mode: 'test',
      leaseOwner: 'lease-a',
      nowMs: FIXED_NOW,
    });
  });

  it('failWorkerCardOrder delegates with leaseFence', async () => {
    const failPendingCardOrder = jest.fn().mockResolvedValue(true);
    const svc = Object.create(OrdersService.prototype) as OrdersService;
    Object.assign(svc, { failPendingCardOrder });
    await svc.failWorkerCardOrder({
      orderId: 'ord-1',
      paymentMode: 'test',
      paymentIntentId: 'pi_1',
      actorUserId: 'cust-1',
      leaseOwner: 'lease-a',
      nowMs: FIXED_NOW,
    });
    expect(failPendingCardOrder).toHaveBeenCalledWith({
      orderId: 'ord-1',
      paymentMode: 'test',
      paymentIntentId: 'pi_1',
      actorUserId: 'cust-1',
      leaseFence: { leaseOwner: 'lease-a', nowMs: FIXED_NOW },
    });
  });
});

describe('PaymentReconcileBoundProcessor', () => {
  let prisma: { order: { findUnique: jest.Mock } };
  let orders: {
    applyWorkerCardSuccess: jest.Mock;
    failWorkerCardOrder: jest.Mock;
  };
  let lease: {
    scheduleNextAttempt: jest.Mock;
    markManualReview: jest.Mock;
  };
  let stripe: {
    retrievePaymentIntentForWebhook: jest.Mock;
    paymentIntents?: { create: jest.Mock; search: jest.Mock; confirm: jest.Mock };
  };
  let worker: { setProcessor: jest.Mock };
  let processor: PaymentReconcileBoundProcessor;

  beforeEach(() => {
    jest.useFakeTimers({ now: FIXED_NOW });
    prisma = {
      order: { findUnique: jest.fn().mockResolvedValue(orderRow()) },
    };
    orders = {
      applyWorkerCardSuccess: jest.fn().mockResolvedValue({ kind: 'claimed' }),
      failWorkerCardOrder: jest.fn().mockResolvedValue(true),
    };
    lease = {
      scheduleNextAttempt: jest.fn().mockResolvedValue(true),
      markManualReview: jest.fn().mockResolvedValue(true),
    };
    stripe = {
      retrievePaymentIntentForWebhook: jest.fn().mockResolvedValue({
        ok: true,
        intent: intent(),
      }),
      paymentIntents: {
        create: jest.fn(),
        search: jest.fn(),
        confirm: jest.fn(),
      },
    };
    worker = { setProcessor: jest.fn() };
    processor = new PaymentReconcileBoundProcessor(
      prisma as never,
      orders as never,
      lease as never,
      stripe as never,
      worker as unknown as PaymentReconcileWorker,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('wires itself onto the worker in the constructor', () => {
    expect(worker.setProcessor).toHaveBeenCalledTimes(1);
  });

  it('does nothing when already invalidated', async () => {
    await processor.process(makeCtx(claimed(), { invalidated: true }));
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(stripe.retrievePaymentIntentForWebhook).not.toHaveBeenCalled();
  });

  it('returns without Stripe when order is no longer PENDING', async () => {
    prisma.order.findUnique.mockResolvedValue(
      orderRow({ paymentStatus: PaymentStatus.PAID }),
    );
    await processor.process(makeCtx(claimed()));
    expect(stripe.retrievePaymentIntentForWebhook).not.toHaveBeenCalled();
    expect(orders.applyWorkerCardSuccess).not.toHaveBeenCalled();
  });

  it('schedules backoff for unbound/malformed PI with no Stripe I/O', async () => {
    prisma.order.findUnique.mockResolvedValue(
      orderRow({ stripePaymentIntentId: null }),
    );
    await processor.process(
      makeCtx(claimed({ stripePaymentIntentId: null, attemptCount: 2 })),
    );
    expect(stripe.retrievePaymentIntentForWebhook).not.toHaveBeenCalled();
    expect(lease.scheduleNextAttempt).toHaveBeenCalledWith({
      orderId: 'ord-1',
      leaseOwner: 'lease-a',
      nextAt: new Date(FIXED_NOW + paymentReconcileBackoffMs(2)),
    });
  });

  it('escalates RETRY_EXHAUSTED for unbound PI at attempt 8 without Stripe', async () => {
    prisma.order.findUnique.mockResolvedValue(
      orderRow({ stripePaymentIntentId: '' }),
    );
    await processor.process(
      makeCtx(
        claimed({
          stripePaymentIntentId: '',
          attemptCount: PAYMENT_RECONCILE_MAX_CLAIMS,
        }),
      ),
    );
    expect(stripe.retrievePaymentIntentForWebhook).not.toHaveBeenCalled();
    expect(lease.markManualReview).toHaveBeenCalledWith({
      orderId: 'ord-1',
      leaseOwner: 'lease-a',
      reason: PaymentReconcileManualReviewReason.RETRY_EXHAUSTED,
    });
    expect(lease.scheduleNextAttempt).not.toHaveBeenCalled();
  });

  it('never retrieves when bound PI changed between claim and re-read', async () => {
    prisma.order.findUnique.mockResolvedValue(
      orderRow({ stripePaymentIntentId: 'pi_new_bind' }),
    );
    await processor.process(
      makeCtx(claimed({ stripePaymentIntentId: 'pi_bound' })),
    );
    expect(stripe.retrievePaymentIntentForWebhook).not.toHaveBeenCalled();
    expect(lease.markManualReview).toHaveBeenCalledWith({
      orderId: 'ord-1',
      leaseOwner: 'lease-a',
      reason: PaymentReconcileManualReviewReason.IDENTITY_MISMATCH,
    });
  });

  it('retrieves only the bound PaymentIntent; never create/search/confirm', async () => {
    await processor.process(makeCtx(claimed()));
    expect(stripe.retrievePaymentIntentForWebhook).toHaveBeenCalledWith(
      'pi_bound',
    );
    expect(stripe.paymentIntents!.create).not.toHaveBeenCalled();
    expect(stripe.paymentIntents!.search).not.toHaveBeenCalled();
    expect(stripe.paymentIntents!.confirm).not.toHaveBeenCalled();
  });

  it('applies fenced success for succeeded + valid identity', async () => {
    await processor.process(makeCtx(claimed()));
    expect(orders.applyWorkerCardSuccess).toHaveBeenCalledWith({
      orderId: 'ord-1',
      customerId: 'cust-1',
      statusHint: OrderStatus.PROCESSING,
      paymentIntentId: 'pi_bound',
      mode: 'test',
      leaseOwner: 'lease-a',
    });
    expect(orders.failWorkerCardOrder).not.toHaveBeenCalled();
  });

  it('fails with fence for canceled + valid identity', async () => {
    stripe.retrievePaymentIntentForWebhook.mockResolvedValue({
      ok: true,
      intent: intent({ status: 'canceled', amountReceived: null }),
    });
    await processor.process(makeCtx(claimed()));
    expect(orders.failWorkerCardOrder).toHaveBeenCalledWith({
      orderId: 'ord-1',
      paymentMode: 'test',
      paymentIntentId: 'pi_bound',
      actorUserId: 'cust-1',
      leaseOwner: 'lease-a',
    });
  });

  it.each([
    'processing',
    'requires_action',
    'requires_payment_method',
    'requires_confirmation',
    'requires_capture',
    'unexpected_status_xyz',
  ])('schedules backoff for non-terminal status %s', async (status) => {
    stripe.retrievePaymentIntentForWebhook.mockResolvedValue({
      ok: true,
      intent: intent({ status, amountReceived: null }),
    });
    await processor.process(makeCtx(claimed({ attemptCount: 2 })));
    expect(orders.applyWorkerCardSuccess).not.toHaveBeenCalled();
    expect(orders.failWorkerCardOrder).not.toHaveBeenCalled();
    expect(lease.scheduleNextAttempt).toHaveBeenCalledWith({
      orderId: 'ord-1',
      leaseOwner: 'lease-a',
      nextAt: new Date(FIXED_NOW + paymentReconcileBackoffMs(2)),
    });
  });

  it('schedules backoff for retrieval/API/429 errors', async () => {
    stripe.retrievePaymentIntentForWebhook.mockResolvedValue({
      ok: false,
      message: 'Rate limit exceeded (429)',
    });
    await processor.process(makeCtx(claimed({ attemptCount: 1 })));
    expect(lease.scheduleNextAttempt).toHaveBeenCalledWith({
      orderId: 'ord-1',
      leaseOwner: 'lease-a',
      nextAt: new Date(FIXED_NOW + paymentReconcileBackoffMs(1)),
    });
    expect(orders.applyWorkerCardSuccess).not.toHaveBeenCalled();
  });

  it('marks RETRY_EXHAUSTED on soft status at attempt 8 (no further schedule)', async () => {
    stripe.retrievePaymentIntentForWebhook.mockResolvedValue({
      ok: true,
      intent: intent({ status: 'processing', amountReceived: null }),
    });
    await processor.process(
      makeCtx(claimed({ attemptCount: PAYMENT_RECONCILE_MAX_CLAIMS })),
    );
    expect(lease.markManualReview).toHaveBeenCalledWith({
      orderId: 'ord-1',
      leaseOwner: 'lease-a',
      reason: PaymentReconcileManualReviewReason.RETRY_EXHAUSTED,
    });
    expect(lease.scheduleNextAttempt).not.toHaveBeenCalled();
  });

  it('at attempt 8 retrieve failure escalates without a ninth Stripe call', async () => {
    stripe.retrievePaymentIntentForWebhook.mockResolvedValue({
      ok: false,
      message: 'network',
    });
    await processor.process(
      makeCtx(claimed({ attemptCount: PAYMENT_RECONCILE_MAX_CLAIMS })),
    );
    expect(stripe.retrievePaymentIntentForWebhook).toHaveBeenCalledTimes(1);
    expect(lease.markManualReview).toHaveBeenCalledWith({
      orderId: 'ord-1',
      leaseOwner: 'lease-a',
      reason: PaymentReconcileManualReviewReason.RETRY_EXHAUSTED,
    });
    expect(lease.scheduleNextAttempt).not.toHaveBeenCalled();
  });

  it('marks IDENTITY_MISMATCH without terminal or retry side effects', async () => {
    stripe.retrievePaymentIntentForWebhook.mockResolvedValue({
      ok: true,
      intent: intent({ metadataOrderId: 'other-order' }),
    });
    await processor.process(makeCtx(claimed()));
    expect(lease.markManualReview).toHaveBeenCalledWith({
      orderId: 'ord-1',
      leaseOwner: 'lease-a',
      reason: PaymentReconcileManualReviewReason.IDENTITY_MISMATCH,
    });
    expect(orders.applyWorkerCardSuccess).not.toHaveBeenCalled();
    expect(orders.failWorkerCardOrder).not.toHaveBeenCalled();
    expect(lease.scheduleNextAttempt).not.toHaveBeenCalled();
  });

  it('skips all mutations after lease invalidation during Stripe retrieve', async () => {
    const ctx = makeCtx(claimed());
    stripe.retrievePaymentIntentForWebhook.mockImplementation(async () => {
      ctx.invalidate();
      return { ok: true, intent: intent() };
    });
    await processor.process(ctx);
    expect(orders.applyWorkerCardSuccess).not.toHaveBeenCalled();
    expect(orders.failWorkerCardOrder).not.toHaveBeenCalled();
    expect(lease.markManualReview).not.toHaveBeenCalled();
    expect(lease.scheduleNextAttempt).not.toHaveBeenCalled();
  });

  it('skips IDENTITY_MISMATCH mutation after lease loss', async () => {
    const ctx = makeCtx(claimed());
    stripe.retrievePaymentIntentForWebhook.mockImplementation(async () => {
      ctx.invalidate();
      return {
        ok: true,
        intent: intent({ metadataOrderId: 'other' }),
      };
    });
    await processor.process(ctx);
    expect(lease.markManualReview).not.toHaveBeenCalled();
  });

  it('skips cancel after invalidation during retrieve (shutdown path)', async () => {
    const ctx = makeCtx(claimed());
    stripe.retrievePaymentIntentForWebhook.mockImplementation(async () => {
      ctx.invalidate();
      return {
        ok: true,
        intent: intent({ status: 'canceled', amountReceived: null }),
      };
    });
    await processor.process(ctx);
    expect(orders.failWorkerCardOrder).not.toHaveBeenCalled();
  });

  it('additive IDENTITY_MISMATCH enum value is available to the client', () => {
    expect(PaymentReconcileManualReviewReason.IDENTITY_MISMATCH).toBe(
      'IDENTITY_MISMATCH',
    );
  });
});
