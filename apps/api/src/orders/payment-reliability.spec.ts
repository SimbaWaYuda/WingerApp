import { ForbiddenException } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma, UserRole } from '@prisma/client';
import { AuthUser } from '../auth/auth.types';
import { AuditService } from '../commissions/audit.service';
import { CommissionsService } from '../commissions/commissions.service';
import { FxService } from '../fx/fx.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { OrdersService } from './orders.service';
import {
  lockShipmentPayments,
  remainingCodPayment,
  shipmentPaymentTotal,
} from './settlement-allocation';
import { ShipmentRefundHoldService } from './shipment-refund-hold.service';
import { StripeService } from './stripe.service';

function customer(): AuthUser {
  return {
    sub: 'cust-1',
    email: 'amina@example.com',
    name: 'Amina',
    role: UserRole.CUSTOMER,
  };
}

function supplier(supplierId = 'sup-1'): AuthUser {
  return {
    sub: 'supplier-user',
    email: 'supplier@kijani.example',
    name: 'Kijani',
    role: UserRole.SUPPLIER,
    supplierId,
  };
}

function admin(): AuthUser {
  return {
    sub: 'admin-1',
    email: 'admin@winger.example',
    name: 'Admin',
    role: UserRole.ADMIN,
  };
}

function orderShell(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-1',
    displayId: 'WG-10999',
    customerId: 'cust-1',
    customerName: 'Amina',
    customerEmail: 'amina@example.com',
    status: OrderStatus.PROCESSING,
    paymentStatus: PaymentStatus.PENDING,
    paymentMethod: 'card',
    paymentMode: 'test',
    stripePaymentIntentId: null as string | null,
    currency: 'USD',
    settlementCurrency: 'USD',
    subtotal: 50,
    taxAmount: 4,
    deliveryFee: 4.99,
    total: 58.99,
    paymentAmount: 58.99,
    paymentCurrency: 'USD',
    addressLine: 'A',
    city: 'B',
    createdAt: new Date('2026-10-09T00:00:00Z'),
    items: [] as Array<Record<string, unknown>>,
    ...overrides,
  };
}

describe('payment and commission reliability', () => {
  let service: OrdersService;
  let prisma: any;
  let commissions: {
    createSnapshotsForOrder: jest.Mock;
    advanceRecognitionForItem: jest.Mock;
    clawbackForOrderItem: jest.Mock;
  };
  let stripe: {
    chargeOrder: jest.Mock;
    checkoutMode: string;
    refundCardCharge: jest.Mock;
    listRefundsForPaymentIntent: jest.Mock;
  };
  let notifications: { notifyReturnStatusChange: jest.Mock };
  let onboarding: { onOrderPlaced: jest.Mock; onSupplierShipped: jest.Mock };
  let audit: { record: jest.Mock };
  let payouts: { transferIfSettleable: jest.Mock; reverseIfTransferred: jest.Mock };

  beforeEach(() => {
    prisma = {
      order: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        aggregate: jest.fn(),
        count: jest.fn(),
      },
      orderItem: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      orderItemCommission: { findMany: jest.fn().mockResolvedValue([]) },
      cashCollection: {
        create: jest.fn().mockResolvedValue({ id: 'col-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      supplier: { count: jest.fn().mockResolvedValue(0) },
      returnRequest: {
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      courierBooking: { updateMany: jest.fn() },
      orderShipment: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
      },
      shipmentRefundHold: {
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn(),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
        create: jest.fn(),
        update: jest.fn(),
      },
      shipmentRefundHoldLegacyEvidence: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      refundAttempt: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      commissionClawback: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      product: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      productVariant: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryLedger: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    // In-memory hold rows for S2.3 LEGACY RETURN path.
    const holdRows = new Map<string, Record<string, unknown>>();
    const evidenceRows: Array<Record<string, unknown>> = [];
    (prisma as { __holdRows?: Map<string, Record<string, unknown>> }).__holdRows =
      holdRows;
    (prisma as { __evidenceRows?: Array<Record<string, unknown>> }).__evidenceRows =
      evidenceRows;
    let evidenceSeq = 0;
    prisma.shipmentRefundHoldLegacyEvidence.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `ev-${++evidenceSeq}`,
          observedAt: new Date(),
          createdAt: new Date(),
          ...data,
        };
        evidenceRows.push(row);
        return { ...row };
      },
    );
    prisma.shipmentRefundHoldLegacyEvidence.findMany.mockImplementation(
      async (args?: {
        where?: { returnRequestId?: string; shipmentRefundHoldId?: string };
      }) => {
        let rows = [...evidenceRows];
        if (args?.where?.returnRequestId) {
          rows = rows.filter(
            (r) => r.returnRequestId === args.where!.returnRequestId,
          );
        }
        if (args?.where?.shipmentRefundHoldId) {
          rows = rows.filter(
            (r) => r.shipmentRefundHoldId === args.where!.shipmentRefundHoldId,
          );
        }
        return rows;
      },
    );
    prisma.shipmentRefundHold.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `hold-${holdRows.size + 1}`,
          legacyStripeClaimedAt: null,
          legacyStripeOutcome: null,
          refundAttemptId: null,
          ...data,
          amount: Number(data.amount),
          returnedMerchandise: Number(data.returnedMerchandise),
        };
        holdRows.set(row.id as string, row);
        return { ...row };
      },
    );
    prisma.shipmentRefundHold.findUnique.mockImplementation(
      async ({ where }: { where: { returnRequestId?: string; id?: string } }) => {
        if (where.returnRequestId) {
          return (
            [...holdRows.values()].find(
              (h) => h.returnRequestId === where.returnRequestId,
            ) ?? null
          );
        }
        if (where.id) return holdRows.get(where.id) ?? null;
        return null;
      },
    );
    prisma.shipmentRefundHold.findUniqueOrThrow.mockImplementation(
      async (args: { where: { returnRequestId?: string; id?: string } }) => {
        const row = await prisma.shipmentRefundHold.findUnique(args);
        if (!row) throw new Error('hold missing');
        return row;
      },
    );
    prisma.shipmentRefundHold.update.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = holdRows.get(where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
    );
    prisma.shipmentRefundHold.aggregate.mockImplementation(
      async ({
        where,
      }: {
        where: { orderShipmentId: string; status: string };
      }) => {
        let sum = 0;
        for (const h of holdRows.values()) {
          if (
            h.orderShipmentId === where.orderShipmentId &&
            h.status === where.status
          ) {
            sum += Number(h.amount);
          }
        }
        return { _sum: { amount: sum } };
      },
    );
    prisma.returnRequest.findUniqueOrThrow.mockImplementation(
      async ({
        where,
        include,
      }: {
        where: { id: string };
        include?: { order?: unknown };
      }) => {
        const sticky = (prisma as { __stickyReturn?: Record<string, unknown> })
          .__stickyReturn;
        if (sticky && sticky.id === where.id) {
          const base = {
            refundDrive: 'UNCLAIMED',
            refundAbandonRequestedAt: null,
            refundedAt: null,
            ...sticky,
          };
          if (include?.order) {
            const order = (sticky.order ?? {}) as {
              stripePaymentIntentId?: string | null;
            };
            return {
              ...base,
              order: {
                stripePaymentIntentId: order.stripePaymentIntentId ?? 'pi_1',
              },
            };
          }
          return base;
        }
        throw new Error('rr missing');
      },
    );
    prisma.orderShipment.findFirst.mockImplementation(
      async ({
        where,
      }: {
        where: { orderId: string; supplierId: string };
      }) => {
        const rows = await prisma.orderShipment.findMany({
          where: { orderId: where.orderId },
        });
        return (
          rows.find(
            (r: { supplierId: string }) => r.supplierId === where.supplierId,
          ) ?? null
        );
      },
    );
    prisma.orderShipment.findUniqueOrThrow.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        const rows = await prisma.orderShipment.findMany({});
        const row = rows.find((r: { id: string }) => r.id === where.id);
        if (!row) throw new Error('ship missing');
        return row;
      },
    );
    prisma.order.findUniqueOrThrow.mockImplementation(
      async ({ where }: { where: { id: string }; select?: unknown }) => {
        const row =
          (await prisma.order.findUnique({ where })) ??
          (await prisma.order.findFirst({ where }));
        if (!row) {
          return {
            id: where.id,
            paymentMode: 'test',
            currency: 'usd',
            stripePaymentIntentId: 'pi_1',
          };
        }
        return {
          currency: 'usd',
          ...row,
        };
      },
    );

    commissions = {
      createSnapshotsForOrder: jest.fn().mockResolvedValue({ created: 1, skipped: 0 }),
      advanceRecognitionForItem: jest.fn().mockResolvedValue(null),
      clawbackForOrderItem: jest.fn().mockResolvedValue({
        clawedBack: true,
        reason: 'ok',
      }),
    };
    stripe = {
      chargeOrder: jest.fn(),
      checkoutMode: 'test',
      refundCardCharge: jest
        .fn()
        .mockResolvedValue({ ok: true, refundId: 're_1', status: 'succeeded' }),
      listRefundsForPaymentIntent: jest.fn().mockResolvedValue({
        ok: true,
        exhausted: true,
        refunds: [],
      }),
    };
    notifications = { notifyReturnStatusChange: jest.fn().mockResolvedValue(undefined) };
    onboarding = {
      onOrderPlaced: jest.fn().mockResolvedValue(undefined),
      onSupplierShipped: jest.fn().mockResolvedValue(undefined),
    };
    audit = { record: jest.fn().mockResolvedValue({}) };
    payouts = {
      transferIfSettleable: jest.fn(),
      reverseIfTransferred: jest.fn().mockResolvedValue(undefined),
    };
    const ledger = {
      sweepSupplier: jest.fn().mockResolvedValue(undefined),
      applyReturnClawback: jest.fn().mockResolvedValue({ legacy: true, applied: false }),
      reserveReturnClawback: jest.fn().mockResolvedValue(null),
    };
    const holds = new ShipmentRefundHoldService(
      prisma as never,
      ledger as never,
      { clawbackForOrderItem: commissions.clawbackForOrderItem } as never,
    );
    service = new OrdersService(
      prisma,
      commissions as unknown as CommissionsService,
      stripe as unknown as StripeService,
      onboarding as unknown as OnboardingService,
      notifications as unknown as NotificationsService,
      {} as FxService,
      audit as unknown as AuditService,
      payouts as never,
      { checkoutLipa: jest.fn().mockResolvedValue({ suppliers: [] }) } as never,
      ledger as never,
      {} as never,
      holds,
    );
  });

  it('returns the existing order when the same checkout is submitted twice', async () => {
    prisma.order.findUnique.mockResolvedValue(
      orderShell({
        paymentStatus: PaymentStatus.PAID,
        stripePaymentIntentId: 'pi_existing',
      }),
    );

    const result = await service.create(
      {
        items: [{ productId: 'p1', quantity: 1 }],
        paymentMethod: 'card',
        checkoutIdempotencyKey: 'checkout-key-1',
      },
      customer(),
    );

    expect(result.displayId).toBe('WG-10999');
    expect(result.stripePaymentIntentId).toBe('pi_existing');
    expect(stripe.chargeOrder).not.toHaveBeenCalled();
  });

  it('keeps PENDING and stock when charge outcome is uncertain', async () => {
    const state = orderShell({
      paymentStatus: PaymentStatus.PENDING,
      status: OrderStatus.PROCESSING,
      stripePaymentIntentId: null,
    });
    prisma.order.findUnique.mockResolvedValue(state);
    prisma.order.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { ...state };
    });
    prisma.order.findUniqueOrThrow.mockImplementation(async () => ({ ...state }));

    const result = await service.recordCardCharge(
      'ord-1',
      {
        mode: 'test',
        status: 'uncertain',
        paymentIntentId: 'pi_uncertain',
        message: 'socket hang up',
      },
      customer(),
    );

    expect(result.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(state.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(state.status).toBe(OrderStatus.PROCESSING);
    expect(state.stripePaymentIntentId).toBe('pi_uncertain');
    expect(prisma.inventoryLedger.create).not.toHaveBeenCalled();
    expect(commissions.createSnapshotsForOrder).not.toHaveBeenCalled();
  });

  it('keeps PENDING and stock for an unrecognised PaymentIntent status mapped to uncertain', async () => {
    const state = orderShell({
      paymentStatus: PaymentStatus.PENDING,
      status: OrderStatus.PROCESSING,
      stripePaymentIntentId: null,
    });
    prisma.order.findUnique.mockResolvedValue(state);
    prisma.order.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { ...state };
    });
    prisma.order.findUniqueOrThrow.mockImplementation(async () => ({ ...state }));

    const result = await service.recordCardCharge(
      'ord-1',
      {
        mode: 'test',
        status: 'uncertain',
        paymentIntentId: 'pi_future_status',
        message: 'Stripe payment status: awaiting_risk_review',
      },
      customer(),
    );

    expect(result.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(state.paymentStatus).toBe(PaymentStatus.PENDING);
    expect(state.status).toBe(OrderStatus.PROCESSING);
    expect(state.stripePaymentIntentId).toBe('pi_future_status');
    expect(prisma.inventoryLedger.create).not.toHaveBeenCalled();
    expect(commissions.createSnapshotsForOrder).not.toHaveBeenCalled();
  });

  it('marks FAILED and restores stock on a definitive card decline', async () => {
    const state = orderShell({
      paymentStatus: PaymentStatus.PENDING,
      status: OrderStatus.PROCESSING,
    });
    prisma.order.findUnique.mockResolvedValue(state);
    prisma.order.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { ...state };
    });
    prisma.orderItem.findMany.mockResolvedValue([
      lineItem({ status: OrderStatus.PROCESSING }),
    ]);
    prisma.product.findUnique.mockResolvedValue({
      id: 'p1',
      stock: 4,
      supplierId: 'sup-1',
    });

    await expect(
      service.recordCardCharge(
        'ord-1',
        {
          mode: 'test',
          status: 'failed',
          paymentIntentId: 'pi_declined',
          message: 'Your card was declined.',
        },
        customer(),
      ),
    ).rejects.toThrow(/declined/i);

    expect(state.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(state.status).toBe(OrderStatus.CANCELLED);
    expect(prisma.inventoryLedger.create).toHaveBeenCalled();
    expect(commissions.createSnapshotsForOrder).not.toHaveBeenCalled();
  });

  it('retries the same PENDING checkout with the same Stripe charge idempotency key', async () => {
    const pending = orderShell({
      paymentStatus: PaymentStatus.PENDING,
      checkoutIdempotencyKey: 'checkout-key-1',
      stripePaymentIntentId: 'pi_uncertain',
    });
    prisma.order.findUnique.mockResolvedValue(pending);
    stripe.chargeOrder.mockResolvedValue({
      mode: 'test',
      status: 'uncertain',
      paymentIntentId: 'pi_uncertain',
      message: 'still pending',
    });
    prisma.order.update.mockResolvedValue(pending);
    prisma.order.findUniqueOrThrow.mockResolvedValue(pending);

    await service.create(
      {
        items: [{ productId: 'p1', quantity: 1 }],
        paymentMethod: 'card',
        stripePaymentMethodId: 'pm_card_visa',
        checkoutIdempotencyKey: 'checkout-key-1',
      },
      customer(),
    );

    expect(stripe.chargeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'ord-1',
        idempotencyKey: 'winger-charge-ord-1',
      }),
    );
    expect(commissions.createSnapshotsForOrder).not.toHaveBeenCalled();
  });

  it('retries saving a PaymentIntent after Stripe succeeded and the first write failed', async () => {
    prisma.order.findUnique.mockResolvedValue(orderShell());
    prisma.order.updateMany
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ count: 1 });
    prisma.order.findUniqueOrThrow.mockResolvedValue(
      orderShell({
        paymentStatus: PaymentStatus.PAID,
        stripePaymentIntentId: 'pi_saved',
        paymentMode: 'test',
      }),
    );

    const result = await service.recordCardCharge(
      'ord-1',
      {
        mode: 'test',
        status: 'paid',
        paymentIntentId: 'pi_saved',
        message: 'Stripe payment succeeded',
      },
      customer(),
    );

    expect(prisma.order.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.order.updateMany.mock.calls[1][0].data.stripePaymentIntentId).toBe(
      'pi_saved',
    );
    expect(commissions.createSnapshotsForOrder).toHaveBeenCalledWith(
      expect.objectContaining({ isDemo: true, paymentMode: 'test' }),
    );
    expect(result.paymentStatus).toBe(PaymentStatus.PAID);
  });

  it('ignores a failed webhook that arrives after payment succeeded, and ignores a duplicate success', async () => {
    const state = orderShell();
    prisma.order.findUnique.mockImplementation(async ({ where }: { where: Record<string, string> }) => {
      if (where.checkoutIdempotencyKey) return null;
      if (where.id === 'ord-1' || where.stripePaymentIntentId === 'pi_1') return { ...state };
      return null;
    });
    prisma.order.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { ...state };
    });
    prisma.order.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      if ((state.paymentStatus as PaymentStatus) === PaymentStatus.PAID) return { count: 0 };
      Object.assign(state, data);
      return { count: 1 };
    });
    prisma.order.findUniqueOrThrow.mockImplementation(async () => ({ ...state }));

    const succeeded = {
      id: 'evt_ok',
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: 'pi_1', metadata: { orderId: 'ord-1' } } },
    };
    const failed = {
      id: 'evt_bad',
      type: 'payment_intent.payment_failed',
      livemode: false,
      data: { object: { id: 'pi_1', metadata: { orderId: 'ord-1' } } },
    };

    await service.handleStripeEvent(succeeded);
    const lateFailure = await service.handleStripeEvent(failed);
    const duplicate = await service.handleStripeEvent(succeeded);

    expect(lateFailure).toMatchObject({ ignored: true });
    expect(duplicate).toMatchObject({ duplicate: true });
    expect(state.paymentStatus).toBe(PaymentStatus.PAID);
    expect(state.stripePaymentIntentId).toBe('pi_1');
    expect(commissions.createSnapshotsForOrder).toHaveBeenCalledWith(
      expect.objectContaining({ isDemo: true }),
    );
  });

  it('applies a success webhook that arrives after a failure webhook', async () => {
    const state = orderShell();
    prisma.order.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.order.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { ...state };
    });
    prisma.order.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { count: 1 };
    });
    prisma.order.findUniqueOrThrow.mockImplementation(async () => ({ ...state }));

    await service.handleStripeEvent({
      type: 'payment_intent.payment_failed',
      livemode: true,
      data: { object: { id: 'pi_live', metadata: { orderId: 'ord-1' } } },
    });
    expect(state.paymentStatus).toBe(PaymentStatus.FAILED);

    await service.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: true,
      data: { object: { id: 'pi_live', metadata: { orderId: 'ord-1' } } },
    });

    expect(state.paymentStatus).toBe(PaymentStatus.PAID);
    expect(commissions.createSnapshotsForOrder).toHaveBeenCalledWith(
      expect.objectContaining({ isDemo: false, paymentMode: 'live' }),
    );
  });

  it('keeps a test card payment out of live revenue', async () => {
    prisma.order.aggregate.mockResolvedValue({ _sum: { subtotal: 100 } });
    prisma.order.count.mockResolvedValue(1);
    prisma.orderItemCommission.findMany.mockResolvedValue([
      reportRow('PENDING', 10, { paymentMode: 'cod', paymentStatus: 'PENDING' }),
      reportRow('RECOGNIZED', 4),
      reportRow('SETTLEABLE', 6),
      reportRow('SETTLEABLE', 8, { itemStatus: 'SHIPPED' }),
      reportRow('RECOGNIZED', 99, { isDemo: true }),
    ]);

    const dashboard = await service.getAdminDashboard(admin());

    expect(dashboard.wingerRevenue).toBe(10);
    expect(dashboard.settleableCommission).toBe(6);
    expect(dashboard.pendingCommission).toBe(10);
    expect(dashboard.recognizedCommission).toBe(4);
  });

  it('does not mark a COD order paid when every line is delivered without collection', async () => {
    const line = lineItem();
    prisma.orderItem.findUnique.mockResolvedValue({
      ...line,
      orderId: 'ord-1',
      order: orderShell({ paymentMode: 'cod', paymentMethod: 'pay_on_delivery' }),
    });
    prisma.orderItem.findMany.mockResolvedValue([{ ...line, status: OrderStatus.DELIVERED }]);
    prisma.order.findUniqueOrThrow.mockResolvedValue(
      orderShell({
        paymentMode: 'cod',
        paymentStatus: PaymentStatus.PENDING,
        items: [{ ...line, status: OrderStatus.DELIVERED }],
      }),
    );

    await service.updateItemStatus(
      'ord-1',
      'item-1',
      { status: OrderStatus.DELIVERED },
      supplier(),
    );

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ paymentStatus: PaymentStatus.PAID }),
      }),
    );
    expect(prisma.cashCollection.create).not.toHaveBeenCalled();
    expect(commissions.advanceRecognitionForItem).toHaveBeenCalledTimes(1);
    expect(commissions.advanceRecognitionForItem).toHaveBeenCalledWith('item-1');
  });

  it('rejects a supplier collecting another supplier’s lines', async () => {
    const line = lineItem({ supplierId: 'sup-2' });
    prisma.orderItem.findUnique.mockResolvedValue({
      ...line,
      orderId: 'ord-1',
      order: orderShell({ paymentMode: 'cod' }),
    });

    await expect(
      service.updateItemStatus('ord-1', 'item-1', { collectPayment: true }, supplier('sup-1')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.cashCollection.create).not.toHaveBeenCalled();
  });

  it('records one collection when two collect requests race', async () => {
    const line = lineItem();
    const order = orderShell({
      paymentMode: 'cod',
      paymentMethod: 'pay_on_delivery',
      items: [line],
    });
    prisma.orderItem.findUnique.mockResolvedValue({ ...line, orderId: 'ord-1', order });
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.order.findUniqueOrThrow.mockResolvedValue(order);
    prisma.cashCollection.findMany.mockResolvedValue([]);
    let creates = 0;
    prisma.cashCollection.create.mockImplementation(async () => {
      creates += 1;
      if (creates > 1) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '5.22.0',
        });
      }
      return { id: 'col-1', supplierId: 'sup-1' };
    });

    await Promise.all([
      service.updateItemStatus('ord-1', 'item-1', { collectPayment: true }, supplier()),
      service.updateItemStatus('ord-1', 'item-1', { collectPayment: true }, supplier()),
    ]);

    expect(creates).toBe(2);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'COD_CASH_COLLECTED',
        after: expect.objectContaining({ supplierId: 'sup-1', amount: 58.99 }),
      }),
    );
  });

  it('refunds a card charge before marking the return issued', async () => {
    const row = issuedReturnRow();
    stubReturnRequestLookups(prisma, row);
    prisma.orderShipment.findMany.mockResolvedValue([
      singleSupplierShipment(row),
    ]);

    await service.updateReturnRequest('ret-1', { refundStatus: 'ISSUED' as never }, admin());

    expect(stripe.refundCardCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: 'pi_1',
        amount: 58.99,
        idempotencyKey: 'winger-refund-ret-1',
        returnRequestId: 'ret-1',
      }),
    );
    expect(prisma.returnRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ refundStatus: 'ISSUED' }) }),
    );
    expect(commissions.clawbackForOrderItem).toHaveBeenCalled();
    const issuedUpdateOrder = prisma.returnRequest.update.mock.calls.findIndex(
      (call: [{ data: { refundStatus?: string } }]) =>
        call[0]?.data?.refundStatus === 'ISSUED',
    );
    expect(issuedUpdateOrder).toBeGreaterThan(-1);
    expect(stripe.refundCardCharge.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.returnRequest.update.mock.invocationCallOrder[issuedUpdateOrder],
    );
  });

  it('leaves a card return unissued when Stripe rejects the refund', async () => {
    const row = issuedReturnRow();
    stubReturnRequestLookups(prisma, row, { markIssued: false });
    prisma.orderShipment.findMany.mockResolvedValue([
      singleSupplierShipment(row),
    ]);
    stripe.refundCardCharge.mockResolvedValueOnce({ ok: false, message: 'Card declined' });

    await expect(
      service.updateReturnRequest('ret-1', { refundStatus: 'ISSUED' as never }, admin()),
    ).rejects.toThrow('Card declined');
    expect(
      prisma.returnRequest.update.mock.calls.some(
        (call: [{ data: { refundStatus?: string } }]) =>
          call[0]?.data?.refundStatus === 'ISSUED',
      ),
    ).toBe(false);
    expect(commissions.clawbackForOrderItem).not.toHaveBeenCalled();
  });

  it('does not call Stripe when a pay-on-delivery return is marked issued', async () => {
    const row = issuedReturnRow({
      order: {
        ...issuedReturnRow().order,
        paymentMode: 'cod',
        stripePaymentIntentId: null,
      },
    });
    stubReturnRequestLookups(prisma, row);
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'ord-1',
      paymentMode: 'cod',
      currency: 'usd',
      stripePaymentIntentId: null,
    });

    await service.updateReturnRequest('ret-1', { refundStatus: 'ISSUED' as never }, supplier());

    expect(stripe.refundCardCharge).not.toHaveBeenCalled();
    expect(commissions.clawbackForOrderItem).toHaveBeenCalled();
  });

  it('refunds a paid card in Stripe before marking the order cancelled', async () => {
    const line = lineItem({ status: OrderStatus.PROCESSING });
    const order = orderShell({
      paymentStatus: PaymentStatus.PAID,
      stripePaymentIntentId: 'pi_1',
      items: [line],
    });
    prisma.order.findFirst.mockResolvedValue(order);
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      status: OrderStatus.CANCELLED,
      paymentStatus: PaymentStatus.REFUNDED,
    });
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.product.findUnique.mockResolvedValue({
      id: 'p1',
      stock: 4,
      supplierId: 'sup-1',
    });

    const result = await service.cancel('ord-1', customer());

    expect(stripe.refundCardCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: 'pi_1',
        amount: 58.99,
        idempotencyKey: 'winger-cancel-ord-1',
        reason: 'cancel',
      }),
    );
    expect(payouts.reverseIfTransferred.mock.invocationCallOrder[0]).toBeLessThan(
      stripe.refundCardCharge.mock.invocationCallOrder[0],
    );
    expect(stripe.refundCardCharge.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$transaction.mock.invocationCallOrder[0],
    );
    expect(result.paymentStatus).toBe(PaymentStatus.REFUNDED);
    expect(result.status).toBe(OrderStatus.CANCELLED);
    expect(commissions.clawbackForOrderItem).toHaveBeenCalledWith(
      expect.objectContaining({ orderItemId: 'item-1' }),
    );
  });

  it('leaves a paid card order unchanged when Stripe rejects the cancel refund', async () => {
    const order = orderShell({
      paymentStatus: PaymentStatus.PAID,
      stripePaymentIntentId: 'pi_1',
      items: [lineItem({ status: OrderStatus.PROCESSING })],
    });
    prisma.order.findFirst.mockResolvedValue(order);
    stripe.refundCardCharge.mockResolvedValueOnce({
      ok: false,
      message: 'insufficient funds',
    });

    await expect(service.cancel('ord-1', customer())).rejects.toThrow(
      'insufficient funds',
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(commissions.clawbackForOrderItem).not.toHaveBeenCalled();
    expect(prisma.inventoryLedger.create).not.toHaveBeenCalled();
  });

  it('does not refund Stripe when reversing a supplier transfer fails', async () => {
    const order = orderShell({
      paymentStatus: PaymentStatus.PAID,
      stripePaymentIntentId: 'pi_1',
      items: [lineItem({ status: OrderStatus.PROCESSING })],
    });
    prisma.order.findFirst.mockResolvedValue(order);
    payouts.reverseIfTransferred.mockRejectedValueOnce(
      new Error('Could not reverse the supplier payout: Stripe error'),
    );

    await expect(service.cancel('ord-1', customer())).rejects.toThrow(
      /reverse the supplier payout/,
    );
    expect(stripe.refundCardCharge).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not refund Stripe again when the order is already cancelled', async () => {
    prisma.order.findFirst.mockResolvedValue(
      orderShell({
        status: OrderStatus.CANCELLED,
        paymentStatus: PaymentStatus.REFUNDED,
        stripePaymentIntentId: 'pi_1',
        items: [lineItem({ status: OrderStatus.CANCELLED })],
      }),
    );

    const result = await service.cancel('ord-1', customer());

    expect(result.status).toBe(OrderStatus.CANCELLED);
    expect(stripe.refundCardCharge).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(commissions.clawbackForOrderItem).toHaveBeenCalled();
  });

  it('does not call Stripe when a demo or unpaid COD order is cancelled', async () => {
    const demo = orderShell({
      paymentMode: 'demo',
      paymentStatus: PaymentStatus.PAID,
      stripePaymentIntentId: null,
      items: [lineItem({ status: OrderStatus.PROCESSING })],
    });
    prisma.order.findFirst.mockResolvedValue(demo);
    prisma.order.findUnique.mockResolvedValue({
      ...demo,
      status: OrderStatus.CANCELLED,
      paymentStatus: PaymentStatus.REFUNDED,
    });
    prisma.orderItem.findMany.mockResolvedValue(demo.items);

    await service.cancel('ord-1', customer());
    expect(stripe.refundCardCharge).not.toHaveBeenCalled();
    expect(commissions.clawbackForOrderItem).toHaveBeenCalled();

    stripe.refundCardCharge.mockClear();
    commissions.clawbackForOrderItem.mockClear();
    const cod = orderShell({
      paymentMode: 'cod',
      paymentMethod: 'pay_on_delivery',
      paymentStatus: PaymentStatus.PENDING,
      stripePaymentIntentId: null,
      items: [lineItem({ status: OrderStatus.PROCESSING })],
    });
    prisma.order.findFirst.mockResolvedValue(cod);
    prisma.order.findUnique.mockResolvedValue({
      ...cod,
      status: OrderStatus.CANCELLED,
      paymentStatus: PaymentStatus.FAILED,
    });
    prisma.orderItem.findMany.mockResolvedValue(cod.items);

    const result = await service.cancel('ord-1', customer());
    expect(stripe.refundCardCharge).not.toHaveBeenCalled();
    expect(result.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(commissions.clawbackForOrderItem).toHaveBeenCalled();
  });

  it('refunds a late success when stock cannot be reserved again', async () => {
    const line = lineItem({ status: OrderStatus.CANCELLED });
    const state = orderShell({
      paymentStatus: PaymentStatus.FAILED,
      status: OrderStatus.CANCELLED,
      stripePaymentIntentId: 'pi_late',
      items: [line],
    });
    prisma.order.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.order.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { ...state };
    });
    prisma.order.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { count: 1 };
    });
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.product.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: 'pi_late', metadata: { orderId: 'ord-1' } } },
    });

    expect(result).toMatchObject({ unsellable: true });
    expect(state.paymentStatus).toBe(PaymentStatus.REFUNDED);
    expect(state.status).toBe(OrderStatus.CANCELLED);
    expect(stripe.refundCardCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: 'pi_late',
        amount: 58.99,
        idempotencyKey: 'winger-webhook-unsellable-ord-1',
        reason: 'unsellable',
      }),
    );
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(commissions.createSnapshotsForOrder).not.toHaveBeenCalled();
  });

  it('does not mark a late payment paid when re-reserve has already been marked unsellable', async () => {
    const line = lineItem({ status: OrderStatus.CANCELLED });
    prisma.order.findUnique.mockResolvedValue(
      orderShell({
        paymentStatus: PaymentStatus.FAILED,
        status: OrderStatus.CANCELLED,
        stripePaymentIntentId: 'pi_late',
        items: [line],
      }),
    );
    prisma.inventoryLedger.findUnique.mockResolvedValue({
      eventId: 'order-unsellable-ord-1',
    });

    const result = await service.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: 'pi_late', metadata: { orderId: 'ord-1' } } },
    });

    expect(result).toMatchObject({ unsellable: true });
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
    expect(stripe.refundCardCharge).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'winger-webhook-unsellable-ord-1' }),
    );
    expect(commissions.createSnapshotsForOrder).not.toHaveBeenCalled();
  });

  it('re-reserves stock for a late success when inventory is still available', async () => {
    const line = lineItem({ status: OrderStatus.CANCELLED });
    const state = orderShell({
      paymentStatus: PaymentStatus.FAILED,
      status: OrderStatus.CANCELLED,
      stripePaymentIntentId: 'pi_late',
      items: [line],
    });
    prisma.order.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.order.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { count: 1 };
    });
    prisma.order.findUniqueOrThrow.mockImplementation(async () => ({ ...state }));
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.product.updateMany.mockResolvedValue({ count: 1 });
    prisma.product.findUniqueOrThrow.mockResolvedValue({
      id: 'p1',
      stock: 4,
      supplierId: 'sup-1',
    });

    await service.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: 'pi_late', metadata: { orderId: 'ord-1' } } },
    });

    expect(state.paymentStatus).toBe(PaymentStatus.PAID);
    expect(prisma.product.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1', stock: { gte: 1 } },
        data: { stock: { decrement: 1 } },
      }),
    );
    expect(prisma.productVariant.updateMany).not.toHaveBeenCalled();
    expect(prisma.inventoryLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: 'order-rereserve-ord-1-p1',
          productId: 'p1',
        }),
      }),
    );
    expect(stripe.refundCardCharge).not.toHaveBeenCalled();
    expect(commissions.createSnapshotsForOrder).toHaveBeenCalled();
  });

  it('re-reserves variant stock for a late success when the line has a variant', async () => {
    const line = lineItem({
      status: OrderStatus.CANCELLED,
      variantId: 'var-1',
      quantity: 2,
    });
    const state = orderShell({
      paymentStatus: PaymentStatus.FAILED,
      status: OrderStatus.CANCELLED,
      stripePaymentIntentId: 'pi_late_var',
      items: [line],
    });
    prisma.order.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.order.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { count: 1 };
    });
    prisma.order.findUniqueOrThrow.mockImplementation(async () => ({ ...state }));
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.productVariant.updateMany.mockResolvedValue({ count: 1 });
    prisma.productVariant.findUniqueOrThrow.mockResolvedValue({
      id: 'var-1',
      stock: 3,
      productId: 'p1',
      enabled: true,
    });
    prisma.productVariant.findMany.mockResolvedValue([
      { id: 'var-1', stock: 3, enabled: true },
    ]);
    prisma.product.findUniqueOrThrow.mockResolvedValue({
      id: 'p1',
      stock: 3,
      supplierId: 'sup-1',
    });

    await service.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: false,
      data: {
        object: { id: 'pi_late_var', metadata: { orderId: 'ord-1' } },
      },
    });

    expect(state.paymentStatus).toBe(PaymentStatus.PAID);
    expect(prisma.productVariant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'var-1', enabled: true, stock: { gte: 2 } },
        data: { stock: { decrement: 2 } },
      }),
    );
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
    expect(prisma.inventoryLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventId: 'order-rereserve-ord-1-p1-var-1',
          variantId: 'var-1',
          delta: -2,
        }),
      }),
    );
    expect(stripe.refundCardCharge).not.toHaveBeenCalled();
  });

  it('does not re-reserve twice when the late-success ledger event already exists', async () => {
    const line = lineItem({
      status: OrderStatus.CANCELLED,
      variantId: 'var-1',
    });
    const state = orderShell({
      paymentStatus: PaymentStatus.FAILED,
      status: OrderStatus.CANCELLED,
      stripePaymentIntentId: 'pi_late_idem',
      items: [line],
    });
    prisma.order.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.order.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { count: 1 };
    });
    prisma.order.findUniqueOrThrow.mockImplementation(async () => ({ ...state }));
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.inventoryLedger.findUnique.mockImplementation(
      async ({ where }: { where: { eventId: string } }) => {
        if (where.eventId === 'order-rereserve-ord-1-p1-var-1') {
          return { eventId: where.eventId };
        }
        return null;
      },
    );

    await service.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: false,
      data: {
        object: { id: 'pi_late_idem', metadata: { orderId: 'ord-1' } },
      },
    });

    expect(state.paymentStatus).toBe(PaymentStatus.PAID);
    expect(prisma.productVariant.updateMany).not.toHaveBeenCalled();
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
    expect(prisma.inventoryLedger.create).not.toHaveBeenCalled();
  });

  it('treats a missing variant as unsellable on late success', async () => {
    const line = lineItem({
      status: OrderStatus.CANCELLED,
      variantId: 'var-missing',
    });
    const state = orderShell({
      paymentStatus: PaymentStatus.FAILED,
      status: OrderStatus.CANCELLED,
      stripePaymentIntentId: 'pi_late_missing',
      items: [line],
    });
    prisma.order.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.order.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { ...state };
    });
    prisma.order.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { count: 1 };
    });
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.productVariant.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: false,
      data: {
        object: { id: 'pi_late_missing', metadata: { orderId: 'ord-1' } },
      },
    });

    expect(result).toMatchObject({ unsellable: true });
    expect(stripe.refundCardCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'winger-webhook-unsellable-ord-1',
        reason: 'unsellable',
      }),
    );
    expect(state.paymentStatus).toBe(PaymentStatus.REFUNDED);
  });

  it('leaves a paid card order unchanged when cancel refund is still pending', async () => {
    const order = orderShell({
      paymentStatus: PaymentStatus.PAID,
      stripePaymentIntentId: 'pi_1',
      items: [lineItem({ status: OrderStatus.PROCESSING })],
    });
    prisma.order.findFirst.mockResolvedValue(order);
    stripe.refundCardCharge.mockResolvedValueOnce({
      ok: true,
      refundId: 're_pending',
      status: 'pending',
    });

    await expect(service.cancel('ord-1', customer())).rejects.toThrow(/pending/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(commissions.clawbackForOrderItem).not.toHaveBeenCalled();
  });

  it('leaves a paid card order unchanged when cancel refund requires action', async () => {
    const order = orderShell({
      paymentStatus: PaymentStatus.PAID,
      stripePaymentIntentId: 'pi_1',
      items: [lineItem({ status: OrderStatus.PROCESSING })],
    });
    prisma.order.findFirst.mockResolvedValue(order);
    stripe.refundCardCharge.mockResolvedValueOnce({
      ok: true,
      refundId: 're_action',
      status: 'requires_action',
    });

    await expect(service.cancel('ord-1', customer())).rejects.toThrow(
      /requires_action/,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('completes cancel when Stripe reports already refunded as succeeded', async () => {
    const line = lineItem({ status: OrderStatus.PROCESSING });
    const order = orderShell({
      paymentStatus: PaymentStatus.PAID,
      stripePaymentIntentId: 'pi_1',
      items: [line],
    });
    prisma.order.findFirst.mockResolvedValue(order);
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      status: OrderStatus.CANCELLED,
      paymentStatus: PaymentStatus.REFUNDED,
    });
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.product.findUnique.mockResolvedValue({
      id: 'p1',
      stock: 4,
      supplierId: 'sup-1',
    });
    stripe.refundCardCharge.mockResolvedValueOnce({
      ok: true,
      refundId: 'already_refunded',
      status: 'succeeded',
    });

    const result = await service.cancel('ord-1', customer());
    expect(result.paymentStatus).toBe(PaymentStatus.REFUNDED);
    expect(result.status).toBe(OrderStatus.CANCELLED);
  });

  it('does not mark unsellable REFUNDED when Stripe refund is still pending', async () => {
    const line = lineItem({ status: OrderStatus.CANCELLED });
    const state = orderShell({
      paymentStatus: PaymentStatus.FAILED,
      status: OrderStatus.CANCELLED,
      stripePaymentIntentId: 'pi_late',
      items: [line],
    });
    prisma.order.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.product.updateMany.mockResolvedValue({ count: 0 });
    stripe.refundCardCharge.mockResolvedValueOnce({
      ok: true,
      refundId: 're_pending',
      status: 'pending',
    });

    await expect(
      service.handleStripeEvent({
        type: 'payment_intent.succeeded',
        livemode: false,
        data: { object: { id: 'pi_late', metadata: { orderId: 'ord-1' } } },
      }),
    ).rejects.toThrow(/pending|not complete|reconciliation/i);
    expect(state.paymentStatus).toBe(PaymentStatus.FAILED);
    expect(stripe.refundCardCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'winger-webhook-unsellable-ord-1',
      }),
    );
  });

  it('NACKs unsellable webhook for requires_action refund without marking REFUNDED', async () => {
    const line = lineItem({ status: OrderStatus.CANCELLED });
    const state = orderShell({
      paymentStatus: PaymentStatus.FAILED,
      status: OrderStatus.CANCELLED,
      stripePaymentIntentId: 'pi_late',
      items: [line],
    });
    prisma.order.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.product.updateMany.mockResolvedValue({ count: 0 });
    stripe.refundCardCharge.mockResolvedValueOnce({
      ok: true,
      refundId: 're_action',
      status: 'requires_action',
    });

    await expect(
      service.handleStripeEvent({
        type: 'payment_intent.succeeded',
        livemode: false,
        data: { object: { id: 'pi_late', metadata: { orderId: 'ord-1' } } },
      }),
    ).rejects.toThrow(/requires_action|not complete|reconciliation/i);
    expect(state.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  it('NACKs unsellable webhook for failed refund without marking REFUNDED', async () => {
    const line = lineItem({ status: OrderStatus.CANCELLED });
    const state = orderShell({
      paymentStatus: PaymentStatus.FAILED,
      status: OrderStatus.CANCELLED,
      stripePaymentIntentId: 'pi_late',
      items: [line],
    });
    prisma.order.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.product.updateMany.mockResolvedValue({ count: 0 });
    stripe.refundCardCharge.mockResolvedValueOnce({
      ok: false,
      message: 'Stripe refund failed',
      refundId: 're_fail',
      status: 'failed',
    });

    await expect(
      service.handleStripeEvent({
        type: 'payment_intent.succeeded',
        livemode: false,
        data: { object: { id: 'pi_late', metadata: { orderId: 'ord-1' } } },
      }),
    ).rejects.toThrow(/failed|not complete/i);
    expect(state.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  it('NACKs unsellable webhook for unknown refund status without marking REFUNDED', async () => {
    const line = lineItem({ status: OrderStatus.CANCELLED });
    const state = orderShell({
      paymentStatus: PaymentStatus.FAILED,
      status: OrderStatus.CANCELLED,
      stripePaymentIntentId: 'pi_late',
      items: [line],
    });
    prisma.order.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.product.updateMany.mockResolvedValue({ count: 0 });
    stripe.refundCardCharge.mockResolvedValueOnce({
      ok: true,
      refundId: 're_unknown',
      status: null,
    });

    await expect(
      service.handleStripeEvent({
        type: 'payment_intent.succeeded',
        livemode: false,
        data: { object: { id: 'pi_late', metadata: { orderId: 'ord-1' } } },
      }),
    ).rejects.toThrow(/unknown|not succeeded|not complete|reconciliation/i);
    expect(state.paymentStatus).toBe(PaymentStatus.FAILED);
  });

  it('retries unsellable webhook with the same refund idempotency key until succeeded', async () => {
    const line = lineItem({ status: OrderStatus.CANCELLED });
    const state = orderShell({
      paymentStatus: PaymentStatus.FAILED,
      status: OrderStatus.CANCELLED,
      stripePaymentIntentId: 'pi_late',
      items: [line],
    });
    prisma.order.findUnique.mockImplementation(async () => ({ ...state }));
    prisma.order.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(state, data);
      return { count: 1 };
    });
    prisma.orderItem.findMany.mockResolvedValue([line]);
    prisma.product.updateMany.mockResolvedValue({ count: 0 });
    stripe.refundCardCharge
      .mockResolvedValueOnce({
        ok: true,
        refundId: 're_pending',
        status: 'pending',
      })
      .mockResolvedValueOnce({
        ok: true,
        refundId: 're_pending',
        status: 'succeeded',
      });

    await expect(
      service.handleStripeEvent({
        type: 'payment_intent.succeeded',
        livemode: false,
        data: { object: { id: 'pi_late', metadata: { orderId: 'ord-1' } } },
      }),
    ).rejects.toThrow(/pending|not complete|reconciliation/i);
    expect(state.paymentStatus).toBe(PaymentStatus.FAILED);

    const retry = await service.handleStripeEvent({
      type: 'payment_intent.succeeded',
      livemode: false,
      data: { object: { id: 'pi_late', metadata: { orderId: 'ord-1' } } },
    });
    expect(retry).toMatchObject({ unsellable: true });
    expect(state.paymentStatus).toBe(PaymentStatus.REFUNDED);
    expect(stripe.refundCardCharge).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: 'winger-webhook-unsellable-ord-1',
      }),
    );
    expect(stripe.refundCardCharge).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: 'winger-webhook-unsellable-ord-1',
      }),
    );
    expect(stripe.refundCardCharge).toHaveBeenCalledTimes(2);
  });

  it('refunds only supplier A’s locked bucket when A’s line is returned', async () => {
    const locked = mixedShipments();
    const row = issuedReturnRow({
      order: {
        ...issuedReturnRow().order,
        paymentAmount: 112.99,
        subtotal: 100,
        total: 112.99,
      },
      orderItem: {
        ...issuedReturnRow().orderItem,
        supplierId: 's-kijani',
        unitPrice: 40,
        lineTotal: 40,
      },
    });
    stubReturnRequestLookups(prisma, row);
    prisma.orderItem.findMany.mockResolvedValue([
      lineItem({ supplierId: 's-kijani', lineTotal: 40, status: OrderStatus.RETURNED }),
      lineItem({
        id: 'item-2',
        supplierId: 's-atlas',
        lineTotal: 60,
        status: OrderStatus.PROCESSING,
      }),
    ]);
    prisma.orderShipment.findMany.mockResolvedValue(locked.map(toShipmentRow));

    await service.updateReturnRequest('ret-1', { refundStatus: 'ISSUED' as never }, admin());

    expect(stripe.refundCardCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: shipmentPaymentTotal(locked[0]),
        reason: 'return',
      }),
    );
    expect(stripe.refundCardCharge.mock.calls[0][0].amount).not.toBe(112.99);
    expect(prisma.orderShipment.update).toHaveBeenCalled();
  });

  it('records COD cash from the supplier bucket, not a share of the whole order', async () => {
    const locked = mixedShipments();
    const line = lineItem({
      supplierId: 's-kijani',
      lineTotal: 40,
      status: OrderStatus.DELIVERED,
    });
    const atlas = lineItem({
      id: 'item-2',
      supplierId: 's-atlas',
      lineTotal: 60,
      status: OrderStatus.PROCESSING,
    });
    const order = orderShell({
      paymentMode: 'cod',
      paymentMethod: 'pay_on_delivery',
      paymentAmount: 112.99,
      subtotal: 100,
      total: 112.99,
      items: [line, atlas],
    });
    prisma.orderItem.findUnique.mockResolvedValue({ ...line, orderId: 'ord-1', order });
    prisma.orderItem.findMany.mockResolvedValue([line, atlas]);
    prisma.order.findUnique.mockResolvedValue(order);
    prisma.order.findUniqueOrThrow.mockResolvedValue(order);
    prisma.orderShipment.findMany.mockResolvedValue(locked.map(toShipmentRow));

    await service.updateItemStatus('ord-1', 'item-1', { collectPayment: true }, supplier('s-kijani'));

    const expected = remainingCodPayment({
      shipment: locked[0],
      liveMerchandise: 40,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({ supplierId: 's-kijani', amount: expected }),
      }),
    );
    expect(expected).not.toBe(roundShare(112.99, 40, 100));
    expect(prisma.order.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paymentStatus: PaymentStatus.PAID }),
      }),
    );
  });

  it('cancels one supplier’s unshipped line without touching the other supplier', async () => {
    const locked = mixedShipments();
    const kijaniLine = lineItem({
      supplierId: 's-kijani',
      lineTotal: 40,
      status: OrderStatus.PROCESSING,
    });
    const atlasLine = lineItem({
      id: 'item-2',
      productId: 'p2',
      supplierId: 's-atlas',
      lineTotal: 60,
      status: OrderStatus.PROCESSING,
    });
    const order = orderShell({
      paymentStatus: PaymentStatus.PAID,
      stripePaymentIntentId: 'pi_1',
      paymentAmount: 112.99,
      subtotal: 100,
      total: 112.99,
      items: [kijaniLine, atlasLine],
    });
    prisma.orderItem.findUnique.mockResolvedValue({
      ...kijaniLine,
      orderId: 'ord-1',
      order,
    });
    prisma.orderItem.findMany.mockResolvedValue([kijaniLine, atlasLine]);
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      ...order,
      items: [{ ...kijaniLine, status: OrderStatus.CANCELLED }, atlasLine],
    });
    prisma.orderShipment.findMany.mockResolvedValue(locked.map(toShipmentRow));
    prisma.product.findUnique.mockResolvedValue({
      id: 'p1',
      stock: 4,
      supplierId: 's-kijani',
    });

    await service.updateItemStatus(
      'ord-1',
      'item-1',
      { status: OrderStatus.CANCELLED },
      supplier('s-kijani'),
    );

    expect(stripe.refundCardCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: shipmentPaymentTotal(locked[0]),
        idempotencyKey: 'winger-line-cancel-item-1',
        reason: 'line_cancel',
      }),
    );
    expect(prisma.orderItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'item-1' },
        data: { status: OrderStatus.CANCELLED },
      }),
    );
    expect(prisma.orderItem.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'item-2' } }),
    );
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ paymentStatus: PaymentStatus.REFUNDED }),
      }),
    );
    expect(commissions.clawbackForOrderItem).toHaveBeenCalledWith(
      expect.objectContaining({ orderItemId: 'item-1' }),
    );
    expect(commissions.clawbackForOrderItem).not.toHaveBeenCalledWith(
      expect.objectContaining({ orderItemId: 'item-2' }),
    );
  });

  describe('S2.3 LEGACY Stripe refund status gate', () => {
    async function holdForReturn(returnRequestId = 'ret-1') {
      return prisma.shipmentRefundHold.findUnique({
        where: { returnRequestId },
      });
    }

    function evidenceForReturn(returnRequestId = 'ret-1') {
      const rows = (
        prisma as { __evidenceRows: Array<Record<string, unknown>> }
      ).__evidenceRows;
      return rows.filter((r) => r.returnRequestId === returnRequestId);
    }

    function expectNotIssued() {
      expect(
        prisma.returnRequest.update.mock.calls.some(
          (call: [{ data: { refundStatus?: string } }]) =>
            call[0]?.data?.refundStatus === 'ISSUED',
        ),
      ).toBe(false);
      expect(commissions.clawbackForOrderItem).not.toHaveBeenCalled();
    }

    function listMatch(status: string, amountCents: number, id = 're_list_1') {
      return {
        ok: true as const,
        exhausted: true as const,
        refunds: [
          {
            id,
            amount: amountCents,
            currency: 'usd',
            status,
            failureReason: null,
            metadata: { returnRequestId: 'ret-1' },
          },
        ],
      };
    }

    async function seedPendingClaim() {
      const row = issuedReturnRow();
      stubReturnRequestLookups(prisma, row, { markIssued: false });
      prisma.orderShipment.findMany.mockResolvedValue([
        singleSupplierShipment(row),
      ]);
      stripe.refundCardCharge.mockResolvedValueOnce({
        ok: true,
        refundId: 're_pending',
        status: 'pending',
      });
      await expect(
        service.updateReturnRequest(
          'ret-1',
          { refundStatus: 'ISSUED' as never },
          admin(),
        ),
      ).rejects.toThrow(/pending/);
      return row;
    }

    it('1. proofJson unchanged after Stripe observations; evidence appended', async () => {
      const row = issuedReturnRow();
      stubReturnRequestLookups(prisma, row, { markIssued: false });
      prisma.orderShipment.findMany.mockResolvedValue([
        singleSupplierShipment(row),
      ]);
      stripe.refundCardCharge.mockResolvedValueOnce({
        ok: true,
        refundId: 're_pending',
        status: 'pending',
      });

      // Capture proof after reserve by running until claim+pending.
      await expect(
        service.updateReturnRequest(
          'ret-1',
          { refundStatus: 'ISSUED' as never },
          admin(),
        ),
      ).rejects.toThrow(/pending/);

      const hold = await holdForReturn();
      const proofAfterFirst = JSON.stringify(hold.proofJson);
      expect(hold.proofJson).not.toHaveProperty('legacyStripeEvidence');
      expect(evidenceForReturn()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            shipmentRefundHoldId: hold.id,
            returnRequestId: 'ret-1',
            stripeRefundId: 're_pending',
            classification: 'PENDING',
            source: 'FRESH_CREATE',
          }),
        ]),
      );

      stripe.refundCardCharge.mockClear();
      stripe.listRefundsForPaymentIntent.mockResolvedValueOnce(
        listMatch('requires_action', hold.amountCents, 're_pending'),
      );
      stubReturnRequestLookups(
        prisma,
        { ...row, refundDrive: 'LEGACY' },
        { markIssued: false },
      );
      await expect(
        service.updateReturnRequest(
          'ret-1',
          { refundStatus: 'ISSUED' as never },
          admin(),
        ),
      ).rejects.toThrow(/requires_action/);

      const after = await holdForReturn();
      expect(JSON.stringify(after.proofJson)).toBe(proofAfterFirst);
      expect(evidenceForReturn()).toHaveLength(2);
      expect(evidenceForReturn()[1]).toEqual(
        expect.objectContaining({
          classification: 'REQUIRES_ACTION',
          source: 'RECOVERY_LIST',
          stripeRefundId: 're_pending',
        }),
      );
    });

    it('2. fresh create succeeded → finalizes exactly once; evidence linked', async () => {
      const row = issuedReturnRow();
      stubReturnRequestLookups(prisma, row);
      prisma.orderShipment.findMany.mockResolvedValue([
        singleSupplierShipment(row),
      ]);
      stripe.refundCardCharge.mockResolvedValueOnce({
        ok: true,
        refundId: 're_ok',
        status: 'succeeded',
      });

      await service.updateReturnRequest(
        'ret-1',
        { refundStatus: 'ISSUED' as never },
        admin(),
      );

      const hold = await holdForReturn();
      expect(hold.status).toBe('CONSUMED');
      expect(hold.legacyStripeOutcome).toBe('SUCCESS_PENDING_FINALIZE');
      expect(hold.proofJson).not.toHaveProperty('legacyStripeEvidence');
      expect(evidenceForReturn()[0]).toEqual(
        expect.objectContaining({
          shipmentRefundHoldId: hold.id,
          returnRequestId: 'ret-1',
          stripeRefundId: 're_ok',
          classification: 'SUCCEEDED',
          source: 'FRESH_CREATE',
        }),
      );
      expect(stripe.refundCardCharge).toHaveBeenCalledTimes(1);
      expect(commissions.clawbackForOrderItem).toHaveBeenCalledTimes(1);
    });

    it('3. fresh create pending/requires_action retain RESERVED', async () => {
      const row = issuedReturnRow();
      stubReturnRequestLookups(prisma, row, { markIssued: false });
      prisma.orderShipment.findMany.mockResolvedValue([
        singleSupplierShipment(row),
      ]);
      stripe.refundCardCharge.mockResolvedValueOnce({
        ok: true,
        refundId: 're_action',
        status: 'requires_action',
      });

      await expect(
        service.updateReturnRequest(
          'ret-1',
          { refundStatus: 'ISSUED' as never },
          admin(),
        ),
      ).rejects.toThrow(/requires_action/);

      const hold = await holdForReturn();
      expect(hold.status).toBe('RESERVED');
      expect(hold.legacyStripeOutcome).toBeNull();
      expect(evidenceForReturn()[0].classification).toBe('REQUIRES_ACTION');
      expectNotIssued();
    });

    it('4. fresh create unknown status → RESERVED; evidence UNKNOWN', async () => {
      const row = issuedReturnRow();
      stubReturnRequestLookups(prisma, row, { markIssued: false });
      prisma.orderShipment.findMany.mockResolvedValue([
        singleSupplierShipment(row),
      ]);
      stripe.refundCardCharge.mockResolvedValueOnce({
        ok: true,
        refundId: 're_weird',
        status: 'processing',
      });

      await expect(
        service.updateReturnRequest(
          'ret-1',
          { refundStatus: 'ISSUED' as never },
          admin(),
        ),
      ).rejects.toThrow(/inconclusive|unknown|processing/i);

      const hold = await holdForReturn();
      expect(hold.status).toBe('RESERVED');
      expect(hold.legacyStripeOutcome).toBeNull();
      expect(evidenceForReturn()[0].classification).toBe('UNKNOWN');
      expectNotIssued();
    });

    it('5. fresh create definitive failed → FAILED_TERMINAL + evidence', async () => {
      const row = issuedReturnRow();
      stubReturnRequestLookups(prisma, row, { markIssued: false });
      prisma.orderShipment.findMany.mockResolvedValue([
        singleSupplierShipment(row),
      ]);
      stripe.refundCardCharge.mockResolvedValueOnce({
        ok: false,
        message: 'Stripe refund failed',
        refundId: 're_failed',
        status: 'failed',
      });

      await expect(
        service.updateReturnRequest(
          'ret-1',
          { refundStatus: 'ISSUED' as never },
          admin(),
        ),
      ).rejects.toThrow(/failed/i);

      const hold = await holdForReturn();
      expect(hold.status).toBe('RESERVED');
      expect(hold.legacyStripeOutcome).toBe('FAILED_TERMINAL');
      expect(evidenceForReturn()[0]).toEqual(
        expect.objectContaining({
          classification: 'FAILED',
          stripeRefundId: 're_failed',
          source: 'FRESH_CREATE',
        }),
      );
      expectNotIssued();
    });

    it('6. fresh create ok:false without Refund status does not FAILED_TERMINAL', async () => {
      const row = issuedReturnRow();
      stubReturnRequestLookups(prisma, row, { markIssued: false });
      prisma.orderShipment.findMany.mockResolvedValue([
        singleSupplierShipment(row),
      ]);
      stripe.refundCardCharge.mockResolvedValueOnce({
        ok: false,
        message: 'Card declined',
      });

      await expect(
        service.updateReturnRequest(
          'ret-1',
          { refundStatus: 'ISSUED' as never },
          admin(),
        ),
      ).rejects.toThrow(/unresolved|Card declined/);

      const hold = await holdForReturn();
      expect(hold.status).toBe('RESERVED');
      expect(hold.legacyStripeOutcome).toBeNull();
      expect(evidenceForReturn()[0]).toEqual(
        expect.objectContaining({
          classification: 'UNRESOLVED_ERROR',
          message: 'Card declined',
        }),
      );
      expectNotIssued();
    });

    it('7. timeout/reset/rate-limit/server error retain RESERVED', async () => {
      const cases = [
        { message: 'socket hang up', uncertain: true },
        { message: 'ECONNRESET', uncertain: true },
        { message: 'rate limit exceeded', uncertain: true },
        { message: '503 Service Unavailable', uncertain: true },
      ];
      for (const c of cases) {
        const row = issuedReturnRow({ id: `ret-${c.message.slice(0, 8)}` });
        // Use ret-1 path with cleared holds between iterations via new service state:
        // reset hold map by deleting keys.
        const holds = (prisma as { __holdRows: Map<string, unknown> }).__holdRows;
        const evidence = (prisma as { __evidenceRows: unknown[] }).__evidenceRows;
        holds.clear();
        evidence.length = 0;
        stubReturnRequestLookups(
          prisma,
          issuedReturnRow(),
          { markIssued: false },
        );
        prisma.orderShipment.findMany.mockResolvedValue([
          singleSupplierShipment(issuedReturnRow()),
        ]);
        stripe.refundCardCharge.mockResolvedValueOnce({
          ok: false,
          message: c.message,
          uncertain: c.uncertain,
        });

        await expect(
          service.updateReturnRequest(
            'ret-1',
            { refundStatus: 'ISSUED' as never },
            admin(),
          ),
        ).rejects.toThrow(/uncertain|unresolved/i);

        const hold = await holdForReturn();
        expect(hold.status).toBe('RESERVED');
        expect(hold.legacyStripeOutcome).toBeNull();
      }
    });

    it('8. recovery succeeded finalizes once without new create', async () => {
      const row = await seedPendingClaim();
      const pendingHold = await holdForReturn();
      const proof = JSON.stringify(pendingHold.proofJson);
      stripe.refundCardCharge.mockClear();
      commissions.clawbackForOrderItem.mockClear();
      stripe.listRefundsForPaymentIntent.mockResolvedValueOnce(
        listMatch('succeeded', pendingHold.amountCents, 're_recovered'),
      );
      stubReturnRequestLookups(prisma, { ...row, refundDrive: 'LEGACY' });

      await service.updateReturnRequest(
        'ret-1',
        { refundStatus: 'ISSUED' as never },
        admin(),
      );

      const hold = await holdForReturn();
      expect(hold.status).toBe('CONSUMED');
      expect(JSON.stringify(hold.proofJson)).toBe(proof);
      expect(stripe.refundCardCharge).not.toHaveBeenCalled();
      expect(evidenceForReturn().some((e: { stripeRefundId?: string }) => e.stripeRefundId === 're_recovered')).toBe(
        true,
      );
      expect(commissions.clawbackForOrderItem).toHaveBeenCalledTimes(1);
    });

    it('9. repeated recovery of pending does not create or consume', async () => {
      const row = await seedPendingClaim();
      const pendingHold = await holdForReturn();
      stripe.refundCardCharge.mockClear();
      stripe.listRefundsForPaymentIntent.mockResolvedValue(
        listMatch('pending', pendingHold.amountCents, 're_still_pending'),
      );
      stubReturnRequestLookups(
        prisma,
        { ...row, refundDrive: 'LEGACY' },
        { markIssued: false },
      );

      await expect(
        service.updateReturnRequest(
          'ret-1',
          { refundStatus: 'ISSUED' as never },
          admin(),
        ),
      ).rejects.toThrow(/pending/);
      await expect(
        service.updateReturnRequest(
          'ret-1',
          { refundStatus: 'ISSUED' as never },
          admin(),
        ),
      ).rejects.toThrow(/pending/);

      const hold = await holdForReturn();
      expect(hold.status).toBe('RESERVED');
      expect(hold.legacyStripeOutcome).toBeNull();
      expect(stripe.refundCardCharge).not.toHaveBeenCalled();
      expect(stripe.listRefundsForPaymentIntent).toHaveBeenCalledTimes(2);
      expect(evidenceForReturn().length).toBeGreaterThanOrEqual(3);
      expectNotIssued();
    });

    it('10. canceled evidence persists as FAILED_TERMINAL', async () => {
      const row = issuedReturnRow();
      stubReturnRequestLookups(prisma, row, { markIssued: false });
      prisma.orderShipment.findMany.mockResolvedValue([
        singleSupplierShipment(row),
      ]);
      stripe.refundCardCharge.mockResolvedValueOnce({
        ok: false,
        message: 'Stripe refund canceled',
        refundId: 're_canceled',
        status: 'canceled',
      });

      await expect(
        service.updateReturnRequest(
          'ret-1',
          { refundStatus: 'ISSUED' as never },
          admin(),
        ),
      ).rejects.toThrow(/canceled/i);

      const hold = await holdForReturn();
      expect(hold.status).toBe('RESERVED');
      expect(hold.legacyStripeOutcome).toBe('FAILED_TERMINAL');
      expect(evidenceForReturn()[0]).toEqual(
        expect.objectContaining({
          classification: 'CANCELED',
          stripeRefundId: 're_canceled',
        }),
      );
    });
  });
});

function mixedShipments() {
  return lockShipmentPayments(
    [
      {
        supplierId: 's-kijani',
        supplierName: 'Kijani Tech',
        merchandise: 40,
        deliveryFee: 4.99,
        merchandiseTax: 3.2,
        deliveryTax: 0,
      },
      {
        supplierId: 's-atlas',
        supplierName: 'Atlas Home',
        merchandise: 60,
        deliveryFee: 0,
        merchandiseTax: 4.8,
        deliveryTax: 0,
      },
    ],
    112.99,
  );
}

function toShipmentRow(
  row: ReturnType<typeof lockShipmentPayments>[number],
  index: number,
) {
  return {
    id: `ship-${index + 1}`,
    orderId: 'ord-1',
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    merchandise: row.merchandise,
    deliveryFee: row.deliveryFee,
    merchandiseTax: row.merchandiseTax,
    deliveryTax: row.deliveryTax,
    paymentMerchandise: row.paymentMerchandise,
    paymentDelivery: row.paymentDelivery,
    paymentTax: row.paymentTax,
    refundedAmount: 0,
  };
}

function roundShare(payment: number, part: number, whole: number) {
  return Math.round(payment * (part / whole) * 100) / 100;
}

function issuedReturnRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ret-1',
    orderId: 'ord-1',
    orderItemId: 'item-1',
    customerId: 'cust-1',
    reason: 'damaged',
    notes: null,
    quantity: 1,
    status: 'APPROVED',
    refundStatus: 'PENDING',
    refundNote: null,
    refundedAt: null,
    refundDrive: 'UNCLAIMED',
    refundAbandonRequestedAt: null,
    createdAt: new Date('2026-10-11T00:00:00Z'),
    order: {
      id: 'ord-1',
      displayId: 'WG-10999',
      paymentMode: 'test',
      currency: 'usd',
      stripePaymentIntentId: 'pi_1',
      paymentAmount: 58.99,
      subtotal: 50,
      total: 58.99,
    },
    orderItem: {
      id: 'item-1',
      supplierId: 'sup-1',
      productName: 'Lamp',
      supplierName: 'Kijani',
      unitPrice: 50,
      quantity: 1,
      lineTotal: 50,
    },
    ...overrides,
  };
}

function stubReturnRequestLookups(
  prisma: {
    returnRequest: { findUnique: jest.Mock; update: jest.Mock };
    __stickyReturn?: Record<string, unknown>;
  },
  row: ReturnType<typeof issuedReturnRow>,
  opts?: { markIssued?: boolean },
) {
  const markIssued = opts?.markIssued !== false;
  let issued = false;
  (prisma as { __stickyReturn?: Record<string, unknown> }).__stickyReturn = {
    ...row,
  };
  prisma.returnRequest.findUnique.mockImplementation(async () => {
    if (issued) {
      return {
        ...row,
        refundStatus: 'ISSUED',
        order: { displayId: 'WG-10999', customerName: 'Amina' },
        orderItem: { productName: 'Lamp', supplierName: 'Kijani' },
      };
    }
    return { ...row, refundStatus: 'PENDING' };
  });
  prisma.returnRequest.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => {
      if (data.refundStatus === 'ISSUED' || data.refundDrive) {
        issued = markIssued && data.refundStatus === 'ISSUED' ? true : issued;
        if (data.refundStatus === 'ISSUED') issued = true;
        (prisma as { __stickyReturn?: Record<string, unknown> }).__stickyReturn = {
          ...row,
          ...data,
        };
      }
      return { ...row, ...data };
    },
  );
}

/** Single-supplier shipment whose payment total matches issuedReturnRow charge. */
function singleSupplierShipment(row: ReturnType<typeof issuedReturnRow>) {
  const paymentAmount = Number(row.order.paymentAmount ?? row.order.total);
  const merchandise = Number(row.orderItem.unitPrice) * Number(row.quantity);
  return {
    id: 'ship-1',
    orderId: row.orderId,
    supplierId: row.orderItem.supplierId,
    supplierName: row.orderItem.supplierName,
    merchandise,
    deliveryFee: roundShare(paymentAmount - merchandise, 1, 1),
    merchandiseTax: 0,
    deliveryTax: 0,
    paymentMerchandise: merchandise,
    paymentDelivery: roundShare(paymentAmount - merchandise, 1, 1),
    paymentTax: 0,
    refundedAmount: 0,
  };
}

function lineItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    productId: 'p1',
    productName: 'Lamp',
    supplierId: 'sup-1',
    supplierName: 'Kijani',
    unitPrice: 50,
    quantity: 1,
    lineTotal: 50,
    status: OrderStatus.SHIPPED,
    trackingCode: null,
    pickupCode: null,
    ...overrides,
  };
}

function reportRow(
  status: string,
  amount: number,
  overrides: {
    isDemo?: boolean;
    itemStatus?: string;
    paymentStatus?: string;
    paymentMode?: string;
  } = {},
) {
  return {
    commissionAmount: amount,
    status,
    isDemo: overrides.isDemo ?? false,
    orderItem: {
      status: overrides.itemStatus ?? 'DELIVERED',
      supplierId: 'sup-1',
      order: {
        paymentStatus: overrides.paymentStatus ?? 'PAID',
        paymentMode: overrides.paymentMode ?? 'card',
        cashCollections: [],
      },
    },
  };
}
