import { OrderStatus, PaymentStatus, UserRole } from '@prisma/client';
import { OrdersService } from './orders.service';

function customer() {
  return {
    sub: 'cust-1',
    email: 'amina@winger.example',
    name: 'Amina',
    role: UserRole.CUSTOMER,
  };
}

describe('cancel remaining unshipped lines', () => {
  function harness(paymentMode: 'test' | 'cod' | 'lipa' = 'test') {
    const items = [
      line('item-a', 'sup-a', OrderStatus.SHIPPED, 80),
      line('item-b', 'sup-b', OrderStatus.PROCESSING, 50),
      line('item-c-bowl', 'sup-c', OrderStatus.DELIVERED, 40),
      line('item-c-spare', 'sup-c', OrderStatus.READY_FOR_PICKUP, 10, 'var-c'),
    ];
    const shipments = [
      bucket('sup-a', 80, 4.99, 8, 0.5),
      bucket('sup-b', 50, 4.99, 5, 0.5),
      bucket('sup-c', 50, 4.99, 5, 0.5),
    ];
    const product = { id: 'p-c', stock: 4, supplierId: 'sup-c' };
    const variants = [
      { id: 'var-c', productId: 'p-c', stock: 2, enabled: true },
      { id: 'var-other', productId: 'p-c', stock: 3, enabled: true },
    ];
    const ledgerEvents: { eventId: string; variantId?: string; delta: number }[] = [];
    const order: {
      id: string;
      status: OrderStatus;
      displayId: string;
      customerId: string;
      customerName: string;
      paymentMode: 'test' | 'cod' | 'lipa';
      paymentStatus: PaymentStatus;
      stripePaymentIntentId: string | null;
      paymentAmount: number;
      subtotal: number;
      total: number;
      currency: string;
      createdAt: Date;
      items: ReturnType<typeof line>[];
    } = {
      id: 'ord-1',
      status: OrderStatus.PROCESSING,
      displayId: 'WG-300',
      customerId: 'cust-1',
      customerName: 'Amina',
      paymentMode,
      paymentStatus: paymentMode === 'cod' ? PaymentStatus.PENDING : PaymentStatus.PAID,
      stripePaymentIntentId: paymentMode === 'test' ? 'pi_1' : null,
      paymentAmount: 214.47,
      subtotal: 180,
      total: 214.47,
      currency: 'USD',
      createdAt: new Date('2026-11-14T12:00:00Z'),
      items,
    };
    let locked = false;
    const waiters: Array<() => void> = [];
    const prisma: any = {
      order: {
        findFirst: jest.fn(async () => order),
        findUnique: jest.fn(async () => order),
        update: jest.fn(async ({ data }: { data: { status?: OrderStatus } }) => {
          if (data.status) order.status = data.status;
          return order;
        }),
      },
      orderItem: {
        findMany: jest.fn(async () => items),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: { status: OrderStatus } }) => {
          const row = items.find((item) => item.id === where.id);
          if (row) row.status = data.status;
          return row;
        }),
      },
      orderShipment: {
        findMany: jest.fn(async () => shipments),
        update: jest.fn(async ({ where, data }: { where: { id: string }; data: { refundedAmount: { toString(): string } } }) => {
          const row = shipments.find((shipment) => shipment.id === where.id);
          if (row) row.refundedAmount = Number(data.refundedAmount);
        }),
      },
      courierBooking: { updateMany: jest.fn() },
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
          const row = variants.find((variant) => variant.id === where.id);
          if (row) row.stock = data.stock;
        }),
      },
      inventoryLedger: {
        findUnique: jest.fn(async ({ where }: { where: { eventId: string } }) =>
          ledgerEvents.find((row) => row.eventId === where.eventId) ?? null,
        ),
        create: jest.fn(async ({ data }: { data: { eventId: string; variantId?: string; delta: number } }) => {
          ledgerEvents.push(data);
          return data;
        }),
      },
      $queryRaw: jest.fn(),
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        while (locked) await new Promise<void>((resolve) => waiters.push(resolve));
        locked = true;
        try {
          return await fn(prisma);
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
    };
    const clawback = jest.fn().mockResolvedValue({ clawedBack: true });
    const payouts = { reverseIfTransferred: jest.fn().mockResolvedValue(undefined) };
    const service = new OrdersService(
      prisma as never,
      { clawbackForOrderItem: clawback } as never,
      stripe as never,
      {} as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      payouts as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, items, shipments, product, variants, ledgerEvents, stripe, clawback, order };
  }

  it('refunds the worked card amounts and leaves shipped lines in place', async () => {
    const state = harness();
    await state.service.cancelRemaining('ord-1', customer());
    expect(state.stripe.refundCardCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 60.49,
        idempotencyKey: 'winger-line-cancel-item-b',
        reason: 'line_cancel',
      }),
    );
    expect(state.stripe.refundCardCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 11,
        idempotencyKey: 'winger-line-cancel-item-c-spare',
        reason: 'line_cancel',
      }),
    );
    expect(state.stripe.refundCardCharge).toHaveBeenCalledTimes(2);
    expect(state.items.find((row) => row.id === 'item-a')?.status).toBe(OrderStatus.SHIPPED);
    expect(state.items.find((row) => row.id === 'item-c-bowl')?.status).toBe(
      OrderStatus.DELIVERED,
    );
    expect(state.items.find((row) => row.id === 'item-b')?.status).toBe(OrderStatus.CANCELLED);
    expect(state.items.find((row) => row.id === 'item-c-spare')?.status).toBe(
      OrderStatus.CANCELLED,
    );
    expect(state.clawback).toHaveBeenCalledWith(
      expect.objectContaining({ orderItemId: 'item-b', tx: expect.anything() }),
    );
    expect(state.clawback).not.toHaveBeenCalledWith(
      expect.objectContaining({ orderItemId: 'item-a' }),
    );
    expect(state.clawback).not.toHaveBeenCalledWith(
      expect.objectContaining({ orderItemId: 'item-c-bowl' }),
    );
    expect(state.variants[0].stock).toBe(3);
    expect(state.product.stock).toBe(6);
    expect(state.ledgerEvents.map((row) => row.eventId)).toEqual([
      'line-cancel-restore-item-b',
      'line-cancel-restore-item-c-spare',
    ]);
    expect(state.order.status).toBe(OrderStatus.PARTIAL);
  });

  it.each(['cod', 'lipa'] as const)(
    'cancels the same lines for %s without calling Stripe',
    async (paymentMode) => {
      const state = harness(paymentMode);
      await state.service.cancelRemaining('ord-1', customer());
      expect(state.stripe.refundCardCharge).not.toHaveBeenCalled();
      expect(state.items.find((row) => row.id === 'item-b')?.status).toBe(OrderStatus.CANCELLED);
      expect(state.items.find((row) => row.id === 'item-a')?.status).toBe(OrderStatus.SHIPPED);
      expect(state.clawback).toHaveBeenCalledTimes(2);
    },
  );

  it('does not refund or restore stock on a repeated or overlapping request', async () => {
    const state = harness();
    await Promise.all([
      state.service.cancelRemaining('ord-1', customer()),
      state.service.cancelRemaining('ord-1', customer()),
    ]);
    await state.service.cancelRemaining('ord-1', customer());
    expect(state.stripe.refundCardCharge).toHaveBeenCalledTimes(2);
    expect(state.ledgerEvents).toHaveLength(2);
    expect(state.clawback).toHaveBeenCalledTimes(2);
    expect(state.shipments.find((row) => row.supplierId === 'sup-b')?.refundedAmount).toBe(60.49);
    expect(state.shipments.find((row) => row.supplierId === 'sup-c')?.refundedAmount).toBe(11);
  });

  it('leaves the order unchanged when the card refund is rejected', async () => {
    const state = harness();
    state.stripe.refundCardCharge.mockResolvedValueOnce({ ok: false, message: 'insufficient funds' });
    await expect(state.service.cancelRemaining('ord-1', customer())).rejects.toThrow(
      'insufficient funds',
    );
    expect(state.items.every((row) => row.status !== OrderStatus.CANCELLED)).toBe(true);
    expect(state.clawback).not.toHaveBeenCalled();
    expect(state.ledgerEvents).toHaveLength(0);
  });

  it('refuses remaining-item cancel when nothing has shipped', async () => {
    const state = harness();
    state.items[0].status = OrderStatus.PROCESSING;
    state.items[2].status = OrderStatus.PROCESSING;
    await expect(state.service.cancelRemaining('ord-1', customer())).rejects.toThrow(
      'Cancel the whole order',
    );
    expect(state.stripe.refundCardCharge).not.toHaveBeenCalled();
  });

  it('keeps entire-order cancel refused after a supplier has shipped', async () => {
    const state = harness();
    await expect(state.service.cancel('ord-1', customer())).rejects.toThrow(
      'Cannot cancel after a supplier has shipped',
    );
  });
});

function line(
  id: string,
  supplierId: string,
  status: OrderStatus,
  lineTotal: number,
  variantId: string | null = null,
) {
  return {
    id,
    orderId: 'ord-1',
    supplierId,
    productId: variantId ? 'p-c' : `p-${id}`,
    variantId,
    quantity: 1,
    lineTotal,
    status,
  };
}

function bucket(
  supplierId: string,
  merchandise: number,
  deliveryFee: number,
  merchandiseTax: number,
  deliveryTax: number,
) {
  return {
    id: `ship-${supplierId}`,
    orderId: 'ord-1',
    supplierId,
    supplierName: supplierId,
    merchandise,
    deliveryFee,
    merchandiseTax,
    deliveryTax,
    paymentMerchandise: merchandise,
    paymentDelivery: deliveryFee,
    paymentTax: roundMoney(merchandiseTax + deliveryTax),
    refundedAmount: 0,
  };
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}
