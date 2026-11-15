import { OrderStatus, PaymentStatus, ReturnRequestStatus, UserRole } from '@prisma/client';
import { OrdersService } from './orders.service';
import { ShipmentRefundHoldService } from './shipment-refund-hold.service';

function admin() {
  return {
    sub: 'admin-1',
    email: 'admin@winger.example',
    name: 'Admin',
    role: UserRole.ADMIN,
  };
}

function supplier() {
  return {
    sub: 'supplier-user',
    email: 'supplier@kijani.example',
    name: 'Kijani',
    role: UserRole.SUPPLIER,
    supplierId: 'sup-1',
  };
}

describe('partial return stock and refund routing', () => {
  function harness(options?: { failLedger?: boolean }) {
    const product = { id: 'p1', stock: 4, supplierId: 'sup-1' };
    const variants = [
      { id: 'var-1', productId: 'p1', stock: 2, enabled: true },
      { id: 'var-2', productId: 'p1', stock: 3, enabled: true },
    ];
    const item = {
      id: 'item-1',
      orderId: 'ord-1',
      productId: 'p1',
      variantId: null as string | null,
      supplierId: 'sup-1',
      unitPrice: 10,
      quantity: 3,
      returnedQuantity: 0,
      status: OrderStatus.DELIVERED as OrderStatus,
      lineTotal: 30,
    };
    const returns = new Map<string, Record<string, unknown>>();
    returns.set('ret-1', returnRow('ret-1', 1));
    const ledgerEvents: { eventId: string; variantId?: string; delta: number }[] = [];
    const clawbacks = new Map<string, { id: string }>();
    const holdRows = new Map<string, Record<string, unknown>>();
    let locked = false;
    const waiters: Array<() => void> = [];
    const snapshot = () => ({
      stock: product.stock,
      variantStock: variants.map((row) => row.stock),
      returnedQuantity: item.returnedQuantity,
      events: ledgerEvents.length,
    });
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'item-1' }]),
      returnRequest: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) => returns.get(where.id)),
        findUniqueOrThrow: jest.fn(
          async ({
            where,
            include,
          }: {
            where: { id: string };
            include?: { order?: unknown };
          }) => {
            const row = returns.get(where.id);
            if (!row) throw new Error('rr missing');
            const base = {
              refundDrive: 'UNCLAIMED',
              refundAbandonRequestedAt: null,
              ...row,
            };
            if (include?.order) {
              const order = (row.order ?? {}) as {
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
          },
        ),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          Object.assign(returns.get(where.id)!, data);
        }),
      },
      orderItem: {
        findUnique: jest.fn(async () => item),
        findMany: jest.fn(async () => [item]),
        update: jest.fn(async ({ data }: { data: { returnedQuantity?: number; status?: OrderStatus } }) => {
          if (data.returnedQuantity != null) item.returnedQuantity = data.returnedQuantity;
          if (data.status) item.status = data.status;
        }),
      },
      product: {
        findUnique: jest.fn(async () => product),
        update: jest.fn(async ({ data }: { data: { stock: number } }) => {
          product.stock = data.stock;
        }),
      },
      productVariant: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          variants.find((row) => row.id === where.id) ?? null,
        ),
        findMany: jest.fn(async () => variants),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: { stock: number } }) => {
          const variant = variants.find((row) => row.id === where.id);
          if (variant) variant.stock = data.stock;
        }),
      },
      inventoryLedger: {
        findUnique: jest.fn(async ({ where }: { where: { eventId: string } }) =>
          ledgerEvents.find((row) => row.eventId === where.eventId) ?? null,
        ),
        create: jest.fn(async ({ data }: { data: { eventId: string; variantId?: string; delta: number } }) => {
          if (options?.failLedger) throw new Error('ledger failed');
          if (ledgerEvents.some((row) => row.eventId === data.eventId)) {
            throw new Error('duplicate ledger event');
          }
          ledgerEvents.push(data);
        }),
      },
      orderShipment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ship-1',
            orderId: 'ord-1',
            supplierId: 'sup-1',
            supplierName: 'Kijani',
            merchandise: 30,
            deliveryFee: 0,
            merchandiseTax: 0,
            deliveryTax: 0,
            paymentMerchandise: 30,
            paymentDelivery: 0,
            paymentTax: 0,
            refundedAmount: 0,
          },
        ]),
        findFirst: jest.fn(async () => ({
          id: 'ship-1',
          orderId: 'ord-1',
          supplierId: 'sup-1',
          supplierName: 'Kijani',
          merchandise: 30,
          deliveryFee: 0,
          merchandiseTax: 0,
          deliveryTax: 0,
          paymentMerchandise: 30,
          paymentDelivery: 0,
          paymentTax: 0,
          refundedAmount: 0,
        })),
        findUniqueOrThrow: jest.fn(async () => ({
          id: 'ship-1',
          orderId: 'ord-1',
          supplierId: 'sup-1',
          supplierName: 'Kijani',
          merchandise: 30,
          deliveryFee: 0,
          merchandiseTax: 0,
          deliveryTax: 0,
          paymentMerchandise: 30,
          paymentDelivery: 0,
          paymentTax: 0,
          refundedAmount: 0,
        })),
        update: jest.fn(),
      },
      order: {
        update: jest.fn().mockResolvedValue({}),
        findUniqueOrThrow: jest.fn(async () => {
          const row = returns.get('ret-1');
          const order = (row?.order ?? {}) as {
            paymentMode?: string;
            stripePaymentIntentId?: string | null;
            currency?: string;
          };
          return {
            id: 'ord-1',
            paymentMode: order.paymentMode ?? 'test',
            currency: order.currency ?? 'usd',
            stripePaymentIntentId: order.stripePaymentIntentId ?? 'pi_1',
          };
        }),
      },
      commissionClawback: {
        findUnique: jest.fn(async ({ where }: { where: { returnRequestId: string } }) =>
          clawbacks.get(where.returnRequestId) ?? null,
        ),
      },
      shipmentRefundHold: {
        findUnique: jest.fn(async ({ where }: { where: { returnRequestId?: string; id?: string } }) => {
          if (where.returnRequestId) {
            return holdRows.get(where.returnRequestId) ?? null;
          }
          if (where.id) {
            return [...holdRows.values()].find((h) => h.id === where.id) ?? null;
          }
          return null;
        }),
        findUniqueOrThrow: jest.fn(),
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 0 } }),
        create: jest.fn(),
        update: jest.fn(),
      },
      shipmentRefundHoldLegacyEvidence: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'ev-1',
          observedAt: new Date(),
          createdAt: new Date(),
          ...data,
        })),
      },
      refundAttempt: { findFirst: jest.fn().mockResolvedValue(null) },
      $executeRaw: jest.fn().mockResolvedValue(1),
    };
    tx.shipmentRefundHold.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        const row: Record<string, unknown> = {
          id: `hold-${holdRows.size + 1}`,
          legacyStripeClaimedAt: null,
          legacyStripeOutcome: null,
          refundAttemptId: null,
          ...data,
          amount: Number(data.amount),
          returnedMerchandise: Number(data.returnedMerchandise),
        };
        holdRows.set(String(row.returnRequestId), row);
        return { ...row };
      },
    );
    tx.shipmentRefundHold.findUniqueOrThrow.mockImplementation(
      async (args: { where: { returnRequestId?: string; id?: string } }) => {
        const row = await tx.shipmentRefundHold.findUnique(args);
        if (!row) throw new Error('hold missing');
        return row;
      },
    );
    tx.shipmentRefundHold.update.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const existing = [...holdRows.values()].find((h) => h.id === where.id)!;
        Object.assign(existing, data);
        return { ...existing };
      },
    );

    const prisma = {
      ...tx,
      $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
        while (locked) {
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
        locked = true;
        const before = snapshot();
        try {
          return await fn(tx);
        } catch (error) {
          product.stock = before.stock;
          variants.forEach((row, index) => {
            row.stock = before.variantStock[index];
          });
          item.returnedQuantity = before.returnedQuantity;
          ledgerEvents.splice(before.events);
          throw error;
        } finally {
          locked = false;
          waiters.shift()?.();
        }
      }),
    };
    const stripe = {
      refundCardCharge: jest
        .fn()
        .mockResolvedValue({ ok: true, refundId: 're_1', status: 'succeeded' }),
      listRefundsForPaymentIntent: jest.fn().mockResolvedValue({
        ok: true,
        exhausted: true,
        refunds: [],
      }),
    };
    const payouts = { reverseIfTransferred: jest.fn().mockResolvedValue(undefined) };
    const ledger = {
      reserveReturnClawback: jest.fn().mockResolvedValue({ id: 'claw-1' }),
      applyReturnClawback: jest.fn().mockResolvedValue({ legacy: false, applied: true }),
      sweepSupplier: jest.fn(),
    };
    const holds = new ShipmentRefundHoldService(
      prisma as never,
      ledger as never,
      { clawbackForOrderItem: jest.fn() } as never,
    );
    const service = new OrdersService(
      prisma as never,
      { clawbackForOrderItem: jest.fn() } as never,
      stripe as never,
      {} as never,
      { notifyReturnStatusChange: jest.fn() } as never,
      {} as never,
      { record: jest.fn() } as never,
      payouts as never,
      {} as never,
      ledger as never,
      {} as never,
      holds,
    );
    return { service, item, product, variants, ledgerEvents, stripe, ledger, returns, payouts, clawbacks };
  }

  it('restores a non-variant product once and keeps the line delivered', async () => {
    const { service, item, product, ledgerEvents } = harness();
    await service.updateReturnRequest('ret-1', { status: ReturnRequestStatus.APPROVED }, admin());
    expect(product.stock).toBe(5);
    expect(item.returnedQuantity).toBe(1);
    expect(item.status).toBe(OrderStatus.DELIVERED);
    expect(ledgerEvents).toEqual([
      expect.objectContaining({ eventId: 'return-restore-ret-1', delta: 1 }),
    ]);
    await service.updateReturnRequest('ret-1', { status: ReturnRequestStatus.APPROVED }, admin());
    expect(product.stock).toBe(5);
    expect(ledgerEvents).toHaveLength(1);
  });

  it('restores the variant and recomputes the parent', async () => {
    const state = harness();
    state.item.variantId = 'var-1';
    await state.service.updateReturnRequest(
      'ret-1',
      { status: ReturnRequestStatus.APPROVED },
      admin(),
    );
    expect(state.variants[0].stock).toBe(3);
    expect(state.variants[1].stock).toBe(3);
    expect(state.product.stock).toBe(6);
    expect(state.ledgerEvents[0].variantId).toBe('var-1');
  });

  it('rolls the stock write back when the ledger insert fails', async () => {
    const { service, product, item } = harness({ failLedger: true });
    await expect(
      service.updateReturnRequest('ret-1', { status: ReturnRequestStatus.APPROVED }, admin()),
    ).rejects.toThrow('ledger failed');
    expect(product.stock).toBe(4);
    expect(item.returnedQuantity).toBe(0);
  });

  it('serializes two approvals so the stock event is written once', async () => {
    const { service, product, ledgerEvents } = harness();
    await Promise.all([
      service.updateReturnRequest('ret-1', { status: ReturnRequestStatus.APPROVED }, admin()),
      service.updateReturnRequest('ret-1', { status: ReturnRequestStatus.APPROVED }, admin()),
    ]);
    expect(product.stock).toBe(5);
    expect(ledgerEvents).toHaveLength(1);
  });

  it.each(['cod', 'lipa', 'test'] as const)(
    'issues a %s refund without charging a second provider',
    async (paymentMode) => {
      const { service, stripe, ledger, returns } = harness();
      const row = returns.get('ret-1')!;
      row.status = ReturnRequestStatus.APPROVED;
      row.refundStatus = 'PENDING';
      (row.order as { paymentMode: string; stripePaymentIntentId: string | null }).paymentMode =
        paymentMode;
      if (paymentMode !== 'test') {
        (row.order as { stripePaymentIntentId: string | null }).stripePaymentIntentId = null;
      }
      await service.updateReturnRequest('ret-1', { refundStatus: 'ISSUED' as never }, supplier());
      expect(ledger.applyReturnClawback).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ returnRequestId: 'ret-1' }),
      );
      if (paymentMode === 'test') {
        expect(stripe.refundCardCharge).toHaveBeenCalled();
      } else {
        expect(stripe.refundCardCharge).not.toHaveBeenCalled();
      }
    },
  );

  it('does not reverse the supplier transfer for a partial return', async () => {
    const { service, payouts, clawbacks, item } = harness();
    clawbacks.set('ret-1', { id: 'claw-1' });
    await service.updateReturnRequest('ret-1', { status: ReturnRequestStatus.APPROVED }, admin());
    expect(item.returnedQuantity).toBe(1);
    expect(item.status).toBe(OrderStatus.DELIVERED);
    await service.updateReturnRequest('ret-1', { refundStatus: 'ISSUED' as never }, supplier());
    expect(payouts.reverseIfTransferred).not.toHaveBeenCalled();
  });

  it('reverses the supplier transfer when approval and refund complete the line together', async () => {
    const { service, payouts, clawbacks, item, returns } = harness();
    item.quantity = 1;
    const row = returns.get('ret-1')!;
    (row.orderItem as { quantity: number }).quantity = 1;
    clawbacks.set('ret-1', { id: 'claw-1' });
    await service.updateReturnRequest(
      'ret-1',
      { status: ReturnRequestStatus.APPROVED, refundStatus: 'ISSUED' as never },
      admin(),
    );
    expect(item.returnedQuantity).toBe(1);
    expect(item.status).toBe(OrderStatus.RETURNED);
    expect(payouts.reverseIfTransferred).toHaveBeenCalledWith('item-1');
  });
});

function returnRow(id: string, quantity: number) {
  return {
    id,
    orderId: 'ord-1',
    orderItemId: 'item-1',
    customerId: 'cust-1',
    quantity,
    createdAt: new Date('2026-11-14T12:00:00Z'),
    status: ReturnRequestStatus.REQUESTED,
    refundStatus: 'NONE',
    refundNote: null,
    refundedAt: null,
    refundDrive: 'UNCLAIMED',
    refundAbandonRequestedAt: null,
    order: {
      id: 'ord-1',
      displayId: 'WG-10999',
      customerName: 'Amina',
      paymentMode: 'test',
      currency: 'usd',
      stripePaymentIntentId: 'pi_1',
      paymentAmount: 30,
      subtotal: 30,
      total: 30,
      paymentStatus: PaymentStatus.PAID,
    },
    orderItem: {
      id: 'item-1',
      productName: 'Sneaker',
      supplierName: 'Kijani',
      supplierId: 'sup-1',
      unitPrice: 10,
      quantity: 1,
      lineTotal: 10,
      status: OrderStatus.DELIVERED,
    },
  };
}
